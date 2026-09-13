import { KafkaContractError, normalizeOutboxEvent } from "@previewforge/contracts";
import { producerSendOptions } from "./kafka/client.js";

export const DEFAULT_OUTBOX_BATCH_SIZE = 50;
export const MAX_OUTBOX_BATCH_SIZE = 100;
export const DEFAULT_OUTBOX_LEASE_DURATION_MS = 30_000;
export const MAX_OUTBOX_LEASE_DURATION_MS = 86_400_000;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const MAX_OUTBOX_MAX_ATTEMPTS = 100;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 86_400_000;
const RETRY_JITTER_RATIO = 0.25;

export type OutboxRelayRow = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  claimToken: string | null;
};

export type OutboxRelayClaimInput = {
  limit: number;
  owner: string;
  maxAttempts?: number;
};

export type OutboxRelayFailureInput = {
  id: string;
  claimToken: string;
  failure: {
    code: string;
    message: string;
    retryable: boolean;
  };
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type OutboxRelayRepository = {
  claimBatch(
    input: OutboxRelayClaimInput & { leaseDurationMs?: number },
  ): Promise<readonly OutboxRelayRow[]>;
  markPublished(id: string, claimToken: string): Promise<OutboxRelayPublishResult>;
  recordFailure(input: OutboxRelayFailureInput): Promise<OutboxRelayFailureResult>;
};

export type OutboxRelayPublishResult = {
  outcome: "PUBLISHED" | "ALREADY_PUBLISHED";
};

export type OutboxRelayFailureResult = {
  outcome: "RETRY_SCHEDULED" | "DEAD_LETTER";
};

type PublishOptions = NonNullable<ReturnType<typeof producerSendOptions>>;

export type OutboxRelayProducer = {
  send(options: PublishOptions): Promise<unknown>;
};

export type OutboxRelayOptions = {
  owner: string;
  batchSize?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
};

export type OutboxRelayResult = {
  claimed: number;
  published: number;
  retryableFailures: number;
  deadLettered: number;
  alreadyPublished: number;
  failed: number;
  staleClaims: number;
  missingClaims: number;
};

/**
 * Relay one bounded claim batch. Each row is isolated so one poison event
 * cannot prevent later committed outbox rows from reaching Kafka.
 */
export async function relayOutboxBatch(
  repository: OutboxRelayRepository,
  producer: OutboxRelayProducer,
  options: OutboxRelayOptions,
): Promise<OutboxRelayResult> {
  const owner = validateOwner(options.owner);
  const limit = boundedBatchSize(options.batchSize);
  const leaseDurationMs = boundedPositiveInteger(
    options.leaseDurationMs ?? DEFAULT_OUTBOX_LEASE_DURATION_MS,
    "outbox lease duration",
    MAX_OUTBOX_LEASE_DURATION_MS,
  );
  const maxAttempts = boundedPositiveInteger(
    options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS,
    "outbox maximum attempts",
    MAX_OUTBOX_MAX_ATTEMPTS,
  );
  const retryBaseDelayMs = boundedPositiveInteger(
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    "retry base delay",
    MAX_RETRY_DELAY_MS,
  );
  const retryMaxDelayMs = boundedPositiveInteger(
    options.retryMaxDelayMs ?? MAX_RETRY_DELAY_MS,
    "retry maximum delay",
    MAX_RETRY_DELAY_MS,
  );
  if (retryBaseDelayMs > retryMaxDelayMs) {
    throw new Error("retry base delay cannot exceed retry maximum delay");
  }
  const random = options.random ?? Math.random;
  const rows = await repository.claimBatch({ limit, owner, leaseDurationMs, maxAttempts });
  const result: OutboxRelayResult = {
    claimed: rows.length,
    published: 0,
    retryableFailures: 0,
    deadLettered: 0,
    alreadyPublished: 0,
    failed: 0,
    staleClaims: 0,
    missingClaims: 0,
  };

  for (const row of rows) {
    await relayRow(repository, producer, row, result, {
      maxAttempts,
      retryBaseDelayMs,
      retryMaxDelayMs,
      random,
    });
  }

  return result;
}

async function relayRow(
  repository: OutboxRelayRepository,
  producer: OutboxRelayProducer,
  row: OutboxRelayRow,
  result: OutboxRelayResult,
  retryOptions: RetryOptions,
): Promise<void> {
  if (
    !Number.isInteger(row.attempts) ||
    row.attempts < 1 ||
    row.attempts > retryOptions.maxAttempts
  ) {
    result.failed += 1;
    return;
  }
  const claimToken = row.claimToken;
  if (claimToken === null) {
    result.failed += 1;
    result.missingClaims += 1;
    return;
  }
  const claimedRow = { ...row, claimToken };

  let normalized: ReturnType<typeof normalizeOutboxEvent>;
  try {
    normalized = normalizeOutboxEvent(row);
  } catch (error) {
    const failure = classifyFailure(error);
    const recorded = await recordFailureSafely(
      repository,
      claimedRow,
      failure,
      result,
      retryOptions,
    );
    countFailureOutcome(result, recorded);
    return;
  }

  try {
    await producer.send(
      producerSendOptions(normalized.topic, [
        {
          key: normalized.key,
          value: normalized.value,
          headers: normalized.headers,
        },
      ]),
    );
  } catch (error) {
    const failure = classifyFailure(error);
    const recorded = await recordFailureSafely(
      repository,
      claimedRow,
      failure,
      result,
      retryOptions,
    );
    countFailureOutcome(result, recorded);
    return;
  }

  // The broker acknowledgement has resolved. Only now may PostgreSQL mark
  // the claimed row published. If this fails, leave the row reclaimable and
  // do not write a failure using a potentially stale claim token.
  try {
    const settled = await repository.markPublished(claimedRow.id, claimedRow.claimToken);
    if (settled.outcome === "PUBLISHED") result.published += 1;
    else result.alreadyPublished += 1;
  } catch (error) {
    result.failed += 1;
    if (isStaleClaimError(error)) result.staleClaims += 1;
  }
}

async function recordFailureSafely(
  repository: OutboxRelayRepository,
  row: OutboxRelayRow & { claimToken: string },
  failure: ClassifiedFailure,
  result: OutboxRelayResult,
  retryOptions: RetryOptions,
): Promise<OutboxRelayFailureResult | null> {
  try {
    const retryDelayMs = failure.retryable
      ? retryDelayMsForAttempt(
          row.attempts,
          retryOptions.retryBaseDelayMs,
          retryOptions.retryMaxDelayMs,
          retryOptions.random,
        )
      : undefined;
    return await repository.recordFailure({
      id: row.id,
      claimToken: row.claimToken,
      failure: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      maxAttempts: retryOptions.maxAttempts,
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    });
  } catch (error) {
    result.failed += 1;
    if (isStaleClaimError(error)) result.staleClaims += 1;
    return null;
  }
}

type RetryOptions = {
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  random: () => number;
};

function countFailureOutcome(
  result: OutboxRelayResult,
  failure: OutboxRelayFailureResult | null,
): void {
  if (failure?.outcome === "DEAD_LETTER") result.deadLettered += 1;
  else if (failure?.outcome === "RETRY_SCHEDULED") result.retryableFailures += 1;
}

function retryDelayMsForAttempt(
  attempts: number,
  baseDelayMs: number,
  maximumDelayMs: number,
  random: () => number,
): number {
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error("retry jitter must be between 0 and 1");
  }
  const attemptExponent = Math.min(Math.max(0, attempts - 1), 31);
  const exponentialDelay = Math.min(maximumDelayMs, baseDelayMs * 2 ** attemptExponent);
  const jitterDelay = Math.floor(exponentialDelay * RETRY_JITTER_RATIO * jitter);
  return Math.min(maximumDelayMs, exponentialDelay + jitterDelay);
}

type ClassifiedFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof KafkaContractError) {
    return {
      code: error.code,
      message: "Kafka outbox contract validation failed",
      retryable: false,
    };
  }

  return {
    code: "KAFKA_TRANSPORT_RETRYABLE",
    message: "Kafka transport failure; retry scheduled",
    retryable: true,
  };
}

function isStaleClaimError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === "STALE_CLAIM" ||
    error.code === "OUTBOX_CLAIM_STALE" ||
    error.code === "OUTBOX_CLAIM_LOST" ||
    error.name === "OutboxRelayStaleClaimError" ||
    error.name === "OutboxClaimLostError"
  );
}

function validateOwner(owner: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(owner)) {
    throw new Error("Invalid outbox relay owner");
  }
  return owner;
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTBOX_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Invalid outbox relay batch size");
  }
  return Math.min(value, MAX_OUTBOX_BATCH_SIZE);
}

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
