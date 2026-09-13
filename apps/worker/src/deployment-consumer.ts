import { type DeploymentRequested, parseKafkaRecord } from "@previewforge/contracts";
import type {
  DeploymentClaimRepository as DatabaseDeploymentClaimRepository,
  DeploymentClaimResult,
  KafkaDeliveryIdentity,
} from "@previewforge/database";
import type { KafkaMessage } from "kafkajs";
import { inspectKafkaRecord } from "./kafka/record.js";

export const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = MAX_RETRY_DELAY_MS;
export const MAX_ATTEMPTS = 100;

const KAFKA_CONTRACT_ERROR_CODES = new Set([
  "INVALID_KAFKA_RECORD",
  "INVALID_JSON",
  "INVALID_EVENT_PAYLOAD",
  "EVENT_IDENTITY_MISMATCH",
  "EVENT_TYPE_IDENTITY_MISMATCH",
  "TOPIC_IDENTITY_MISMATCH",
  "HEADER_IDENTITY_MISMATCH",
  "KEY_IDENTITY_MISMATCH",
  "AGGREGATE_IDENTITY_MISMATCH",
]);

export type DeploymentConsumerRecord = Pick<KafkaMessage, "key" | "headers" | "value"> & {
  topic: string;
  partition: number;
  offset: string;
};

export type DeploymentClaimRepository = Pick<
  DatabaseDeploymentClaimRepository,
  "claimRequestedDeployment" | "recordDeadLetter" | "scheduleRetry"
>;

export type DeploymentOffsetCommitter = {
  commitOffset(input: { topic: string; partition: number; offset: string }): Promise<unknown>;
};

export type DeploymentConsumerOptions = {
  repository: DeploymentClaimRepository;
  offsets: DeploymentOffsetCommitter;
  consumerName: string;
  workerId: string;
  leaseTtlMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  afterDatabaseCommitBeforeOffsetCommit?: () => Promise<void>;
};

export type DeploymentConsumerOutcome =
  | { kind: "PROCESSED" | "ALREADY_PROCESSED" | "SUPERSEDED"; committed: true }
  | { kind: "DEAD_LETTERED" | "ALREADY_DEAD_LETTERED"; committed: true }
  | { kind: "RETRY_SCHEDULED" | "RETRY_DEFERRED"; committed: false; code: string }
  | { kind: "FAILED" | "OFFSET_COMMIT_FAILED"; committed: false; code: string };

/**
 * Handle one Kafka message without coupling the worker loop to KafkaJS or
 * PostgreSQL implementations. The caller decides whether to continue its
 * loop from the safe outcome; this function never commits an offset before a
 * durable terminal/processed outcome.
 */
export async function handleDeploymentMessage(
  record: DeploymentConsumerRecord,
  options: DeploymentConsumerOptions,
): Promise<DeploymentConsumerOutcome> {
  const maxAttempts = boundedAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = boundedPositiveRetryDelay(
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    "retry base delay",
  );
  const retryMaxDelayMs = boundedPositiveRetryDelay(
    options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    "retry maximum delay",
  );
  if (retryBaseDelayMs > retryMaxDelayMs) {
    throw new Error("Invalid deployment consumer retry delay range");
  }
  const leaseTtlMs = boundedPositiveDuration(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
  const inspected = inspectKafkaRecord(record);
  const delivery = createDeliveryIdentity(record, inspected, options.consumerName);
  const safeHeaderEvent = safeHeaderEventIdentity(inspected);

  let parsed: ReturnType<typeof parseKafkaRecord>;
  try {
    parsed = parseKafkaRecord({
      topic: record.topic,
      key: record.key,
      value: record.value,
      headers: record.headers,
    });
  } catch (error) {
    return handlePermanentFailure(
      delivery,
      safeHeaderEvent,
      classifyPermanentError(error),
      options,
    );
  }

  if (parsed.event.eventType !== "deployment.requested.v1") {
    return handlePermanentFailure(
      {
        ...delivery,
        eventId: parsed.event.eventId,
        eventType: parsed.event.eventType,
        environmentId: parsed.event.environmentId,
      },
      undefined,
      { code: "UNSUPPORTED_DEPLOYMENT_EVENT", message: "Deployment event is not claimable" },
      options,
    );
  }

  const event = parsed.event;
  const eventDelivery = {
    ...delivery,
    eventId: event.eventId,
    eventType: event.eventType,
    environmentId: event.environmentId,
    aggregateId: event.deploymentId,
  };

  try {
    const result = await options.repository.claimRequestedDeployment({
      delivery: eventDelivery,
      event,
      workerId: options.workerId,
      leaseTtlMs,
    });
    const outcomeKind = claimOutcomeKind(result);
    return await commitAfterDurableOutcome(record, options, outcomeKind);
  } catch (error) {
    const notClaimable = classifyNotClaimableError(error);
    if (notClaimable === "DEAD_LETTER") {
      return commitAfterDurableOutcome(record, options, "ALREADY_DEAD_LETTERED");
    }
    if (notClaimable === "RETRY_NOT_DUE") {
      return { kind: "RETRY_DEFERRED", committed: false, code: "DELIVERY_RETRY_NOT_DUE" };
    }

    const failure = classifyClaimError(error);
    if (failure.permanent) {
      return handlePermanentFailure(eventDelivery, safeHeaderEvent, failure, options);
    }

    if (!failure.transient) {
      return { kind: "FAILED", committed: false, code: failure.code };
    }

    try {
      const retryResult = await options.repository.scheduleRetry({
        delivery: eventDelivery,
        event: event,
        errorCode: failure.code,
        message: failure.message,
        maxAttempts,
        retryBaseDelayMs,
        retryMaxDelayMs,
      });
      if (retryResult.outcome === "DEAD_LETTER") {
        return await commitAfterDurableOutcome(record, options, "DEAD_LETTERED");
      }
      if (retryResult.outcome === "RETRY_SCHEDULED") {
        return { kind: "RETRY_SCHEDULED", committed: false, code: failure.code };
      }
      return assertNever(retryResult.outcome);
    } catch {
      return { kind: "FAILED", committed: false, code: "RETRY_PERSISTENCE_FAILED" };
    }
  }
}

async function handlePermanentFailure(
  delivery: KafkaDeliveryIdentity,
  event: Partial<Pick<DeploymentRequested, "eventId" | "eventType" | "environmentId">> | undefined,
  failure: SafeFailure,
  options: DeploymentConsumerOptions,
): Promise<DeploymentConsumerOutcome> {
  try {
    const deadLetterInput = {
      delivery,
      errorCode: failure.code,
      message: failure.message,
      ...(event === undefined ? {} : { event }),
    };
    await options.repository.recordDeadLetter(deadLetterInput);
    return await commitAfterDurableOutcome(
      { topic: delivery.topic, partition: delivery.partition, offset: String(delivery.offset) },
      options,
      "DEAD_LETTERED",
    );
  } catch {
    return { kind: "FAILED", committed: false, code: "DEAD_LETTER_PERSISTENCE_FAILED" };
  }
}

async function commitOutcome(
  record: Pick<DeploymentConsumerRecord, "topic" | "partition" | "offset">,
  options: DeploymentConsumerOptions,
  kind:
    | "PROCESSED"
    | "ALREADY_PROCESSED"
    | "SUPERSEDED"
    | "DEAD_LETTERED"
    | "ALREADY_DEAD_LETTERED",
): Promise<DeploymentConsumerOutcome> {
  try {
    await options.offsets.commitOffset({
      topic: record.topic,
      partition: record.partition,
      offset: nextOffset(record.offset),
    });
    if (kind === "ALREADY_DEAD_LETTERED") return { kind, committed: true };
    if (kind === "DEAD_LETTERED") return { kind, committed: true };
    if (kind === "ALREADY_PROCESSED") return { kind, committed: true };
    return { kind, committed: true };
  } catch {
    return { kind: "OFFSET_COMMIT_FAILED", committed: false, code: "OFFSET_COMMIT_FAILED" };
  }
}

async function commitAfterDurableOutcome(
  record: Pick<DeploymentConsumerRecord, "topic" | "partition" | "offset">,
  options: DeploymentConsumerOptions,
  kind:
    | "PROCESSED"
    | "ALREADY_PROCESSED"
    | "SUPERSEDED"
    | "DEAD_LETTERED"
    | "ALREADY_DEAD_LETTERED",
): Promise<DeploymentConsumerOutcome> {
  try {
    await runBeforeOffsetCommitHook(options);
  } catch {
    return { kind: "FAILED", committed: false, code: "OFFSET_COMMIT_DEFERRED" };
  }
  return commitOutcome(record, options, kind);
}

async function runBeforeOffsetCommitHook(options: DeploymentConsumerOptions): Promise<void> {
  await options.afterDatabaseCommitBeforeOffsetCommit?.();
}

function createDeliveryIdentity(
  record: DeploymentConsumerRecord,
  inspected: ReturnType<typeof inspectKafkaRecord>,
  consumerName: string,
): KafkaDeliveryIdentity {
  const eventId =
    inspected.eventId.ok && isUuid(inspected.eventId.value) ? inspected.eventId.value : undefined;
  const eventType =
    inspected.eventType.ok && isKafkaEventType(inspected.eventType.value)
      ? inspected.eventType.value
      : undefined;
  return {
    consumerName,
    topic: record.topic,
    partition: record.partition,
    offset: record.offset,
    payloadDigest: inspected.value.payloadSha256,
    ...(eventId === undefined ? {} : { eventId }),
    ...(eventType === undefined ? {} : { eventType }),
  };
}

function safeHeaderEventIdentity(
  inspected: ReturnType<typeof inspectKafkaRecord>,
): Partial<Pick<DeploymentRequested, "eventId" | "eventType" | "environmentId">> | undefined {
  const eventId =
    inspected.eventId.ok && isUuid(inspected.eventId.value) ? inspected.eventId.value : undefined;
  const eventType =
    inspected.eventType.ok && inspected.eventType.value === "deployment.requested.v1"
      ? inspected.eventType.value
      : undefined;
  if (eventId === undefined && eventType === undefined) return undefined;
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(eventType === undefined ? {} : { eventType }),
  };
}

function claimOutcomeKind(
  result: DeploymentClaimResult,
): "PROCESSED" | "ALREADY_PROCESSED" | "SUPERSEDED" {
  switch (result.kind) {
    case "CLAIMED":
    case "RECLAIMED":
      return "PROCESSED";
    case "DUPLICATE_ACTIVE_LEASE":
    case "DUPLICATE_TERMINAL":
      return "ALREADY_PROCESSED";
    case "SUPERSEDED":
      return "SUPERSEDED";
    default:
      return assertNever(result);
  }
}

type SafeFailure = { code: string; message: string; permanent?: boolean; transient?: boolean };

function classifyPermanentError(error: unknown): SafeFailure {
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    KAFKA_CONTRACT_ERROR_CODES.has(error.code)
  ) {
    return {
      code: error.code,
      message: "Kafka record contract validation failed",
      permanent: true,
    };
  }
  return { code: "INVALID_KAFKA_RECORD", message: "Kafka record is invalid", permanent: true };
}

function classifyClaimError(error: unknown): SafeFailure {
  if (isRecord(error)) {
    if (error.code === "KAFKA_DELIVERY_IDENTITY_CONFLICT") {
      return {
        code: "KAFKA_DELIVERY_IDENTITY_CONFLICT",
        message: "Kafka delivery identity conflicts with durable metadata",
        permanent: true,
      };
    }
    if (
      error.code === "DEPLOYMENT_AGGREGATE_MISMATCH" ||
      error.code === "DEPLOYMENT_CLAIM_INVARIANT" ||
      error.code === "DEPLOYMENT_STATE_INVALID"
    ) {
      return {
        code: error.code,
        message: "Deployment aggregate or state invariant rejected the claim",
        permanent: true,
      };
    }
    if (typeof error.code === "string" && error.code === "DELIVERY_DEAD_LETTER") {
      return {
        code: error.code,
        message: "Kafka delivery is already dead-lettered",
        permanent: true,
      };
    }
    if (error.retriable === true || isTransientCode(error.code) || isTransientName(error.name)) {
      return {
        code: "DEPLOYMENT_CLAIM_RETRYABLE",
        message: "Deployment claim retry scheduled",
        transient: true,
      };
    }
  }
  return { code: "DEPLOYMENT_CLAIM_FAILED", message: "Deployment claim failed" };
}

function classifyNotClaimableError(error: unknown): "DEAD_LETTER" | "RETRY_NOT_DUE" | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  if (error.code === "DELIVERY_DEAD_LETTER") return "DEAD_LETTER";
  if (error.code === "DELIVERY_RETRY_NOT_DUE") return "RETRY_NOT_DUE";
  return undefined;
}

function isTransientName(name: unknown): boolean {
  return (
    name === "KafkaJSConnectionError" ||
    name === "KafkaJSConnectionClosedError" ||
    name === "KafkaJSRequestTimeoutError" ||
    name === "KafkaJSNoBrokerAvailableError" ||
    name === "KafkaJSNumberOfRetriesExceeded"
  );
}

function isTransientCode(code: unknown): boolean {
  return (
    code === "DEPLOYMENT_CLAIM_RACE" ||
    code === "DEPLOYMENT_DATABASE_TIME_UNAVAILABLE" ||
    code === "DEPLOYMENT_DURABLE_CONFLICT" ||
    code === "P2034" ||
    code === "40001" ||
    code === "40P01" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isKafkaEventType(value: string): boolean {
  return /^[a-z][a-z0-9.-]{0,127}$/.test(value);
}

function nextOffset(offset: string): string {
  try {
    const value = BigInt(offset);
    if (value < 0n) throw new Error("negative offset");
    return (value + 1n).toString();
  } catch {
    throw new Error("invalid Kafka offset");
  }
}

function boundedPositiveRetryDelay(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETRY_DELAY_MS) {
    throw new Error(`Invalid deployment consumer ${label}`);
  }
  return value;
}

function boundedAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS) {
    throw new Error("Invalid deployment consumer max attempts");
  }
  return value;
}

function boundedPositiveDuration(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RETRY_DELAY_MS) {
    throw new Error("Invalid deployment consumer lease TTL");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected deployment consumer outcome: ${String(value)}`);
}
