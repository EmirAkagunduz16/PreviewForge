import { KafkaContractError, normalizeOutboxEvent } from "@previewforge/contracts";
import { producerSendOptions } from "./kafka/client.js";

export const DEFAULT_OUTBOX_BATCH_SIZE = 50;
export const MAX_OUTBOX_BATCH_SIZE = 100;

export type OutboxRelayRow = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  claimToken: string | null;
};

export type OutboxRelayClaimInput = {
  limit: number;
  owner: string;
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
  markPublished(id: string, claimToken: string): Promise<unknown>;
  recordFailure(input: OutboxRelayFailureInput): Promise<unknown>;
};

type PublishOptions = NonNullable<ReturnType<typeof producerSendOptions>>;

export type OutboxRelayProducer = {
  send(options: PublishOptions): Promise<unknown>;
};

export type OutboxRelayOptions = {
  owner: string;
  batchSize?: number;
};

export type OutboxRelayResult = {
  claimed: number;
  published: number;
  retryableFailures: number;
  deadLettered: number;
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
  const rows = await repository.claimBatch({ limit, owner });
  const result: OutboxRelayResult = {
    claimed: rows.length,
    published: 0,
    retryableFailures: 0,
    deadLettered: 0,
    failed: 0,
    staleClaims: 0,
    missingClaims: 0,
  };

  for (const row of rows) {
    await relayRow(repository, producer, row, result);
  }

  return result;
}

async function relayRow(
  repository: OutboxRelayRepository,
  producer: OutboxRelayProducer,
  row: OutboxRelayRow,
  result: OutboxRelayResult,
): Promise<void> {
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
    const recorded = await recordFailureSafely(repository, claimedRow, failure, result);
    if (recorded) result.deadLettered += 1;
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
    const recorded = await recordFailureSafely(repository, claimedRow, failure, result);
    if (recorded) {
      if (failure.retryable) result.retryableFailures += 1;
      else result.deadLettered += 1;
    }
    return;
  }

  // The broker acknowledgement has resolved. Only now may PostgreSQL mark
  // the claimed row published. If this fails, leave the row reclaimable and
  // do not write a failure using a potentially stale claim token.
  try {
    await repository.markPublished(claimedRow.id, claimedRow.claimToken);
    result.published += 1;
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
): Promise<boolean> {
  try {
    await repository.recordFailure({
      id: row.id,
      claimToken: row.claimToken,
      failure: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    });
    return true;
  } catch (error) {
    result.failed += 1;
    if (isStaleClaimError(error)) result.staleClaims += 1;
    return false;
  }
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

  if (isRetryableTransportError(error)) {
    return {
      code: "KAFKA_TRANSPORT_RETRYABLE",
      message: "Kafka transport failure; retry scheduled",
      retryable: true,
    };
  }

  return {
    code: "OUTBOX_RELAY_FAILED",
    message: "Outbox relay failed with an unclassified error",
    retryable: false,
  };
}

function isRetryableTransportError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.retriable === true) return true;

  if (
    error.code === "ECONNRESET" ||
    error.code === "ECONNREFUSED" ||
    error.code === "ETIMEDOUT" ||
    error.code === "EPIPE" ||
    error.code === "ENETUNREACH" ||
    error.code === "EAI_AGAIN"
  ) {
    return true;
  }

  return (
    error.name === "KafkaJSConnectionError" ||
    error.name === "KafkaJSConnectionClosedError" ||
    error.name === "KafkaJSRequestTimeoutError" ||
    error.name === "KafkaJSNoBrokerAvailableError" ||
    error.name === "KafkaJSNumberOfRetriesExceeded"
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
