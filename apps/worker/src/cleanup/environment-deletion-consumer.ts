import {
  type EnvironmentDeletionRequested,
  type KafkaEvent,
  parseKafkaRecord,
} from "@previewforge/contracts";
import type {
  DeploymentFeedbackRepository,
  EnvironmentDeletionRepository,
  FeedbackDeliveryIdentity,
} from "@previewforge/database";
import type { KafkaMessage } from "kafkajs";
import { inspectKafkaRecord } from "../kafka/record.js";

export type EnvironmentDeletionConsumerRecord = Pick<KafkaMessage, "key" | "headers" | "value"> & {
  topic: string;
  partition: number;
  offset: string;
};

export type EnvironmentDeletionConsumerOptions = {
  repository: Pick<EnvironmentDeletionRepository, "process">;
  deliveryRepository: Pick<
    DeploymentFeedbackRepository,
    "claimDelivery" | "markDeliveryProcessed" | "scheduleRetry" | "recordDeadLetter"
  >;
  deleteNamespace: (environmentId: string) => Promise<void>;
  consumerName: string;
  offsets: {
    commitOffset(input: { topic: string; partition: number; offset: string }): Promise<unknown>;
  };
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export type EnvironmentDeletionConsumerOutcome =
  | { kind: "PROCESSED" | "ALREADY_PROCESSED" | "DEAD_LETTERED"; committed: true }
  | { kind: "RETRY_SCHEDULED" | "RETRY_DEFERRED"; committed: false; code: string }
  | { kind: "FAILED"; committed: false; code: string };

export async function handleEnvironmentDeletionMessage(
  record: EnvironmentDeletionConsumerRecord,
  options: EnvironmentDeletionConsumerOptions,
): Promise<EnvironmentDeletionConsumerOutcome> {
  const inspected = inspectKafkaRecord(record);
  const baseDelivery = createDeliveryIdentity(record, inspected, options.consumerName);

  let event: KafkaEvent;
  try {
    event = parseKafkaRecord({
      topic: record.topic,
      key: record.key,
      value: record.value,
      headers: record.headers,
    }).event;
  } catch (error) {
    return settlePermanentFailure(record, baseDelivery, options, contractErrorCode(error));
  }
  if (event.eventType !== "environment.deletion-requested.v1") {
    return settlePermanentFailure(record, baseDelivery, options, "UNSUPPORTED_DELETION_EVENT");
  }

  const deletionEvent = event as EnvironmentDeletionRequested;
  const delivery = {
    ...baseDelivery,
    eventId: deletionEvent.eventId,
    eventType: deletionEvent.eventType,
    environmentId: deletionEvent.environmentId,
    aggregateId: deletionEvent.environmentId,
  } satisfies FeedbackDeliveryIdentity;

  let claim: Awaited<ReturnType<DeploymentFeedbackRepository["claimDelivery"]>>;
  try {
    claim = await options.deliveryRepository.claimDelivery(delivery);
  } catch {
    return { kind: "FAILED", committed: false, code: "DELETION_DELIVERY_CLAIM_FAILED" };
  }
  if (claim.kind === "PROCESSED" || claim.kind === "DEAD_LETTER") {
    return commit(record, options, "ALREADY_PROCESSED");
  }
  if (claim.kind === "RETRY_NOT_DUE") {
    return { kind: "RETRY_DEFERRED", committed: false, code: "DELETION_RETRY_NOT_DUE" };
  }

  try {
    const result = await options.repository.process({
      event: deletionEvent,
      deleteNamespace: options.deleteNamespace,
    });
    if (result.kind !== "FAILED") {
      await options.deliveryRepository.markDeliveryProcessed(delivery);
      return commit(record, options, "PROCESSED");
    }

    const outcome = await recordFailure(
      delivery,
      deletionEvent,
      options,
      result.code,
      result.retryable,
      result.message,
    );
    if (outcome === "DEAD_LETTER") return commit(record, options, "DEAD_LETTERED");
    if (outcome === "RETRY_SCHEDULED") {
      return { kind: "RETRY_SCHEDULED", committed: false, code: result.code };
    }
    return { kind: "FAILED", committed: false, code: "DELETION_FAILURE_PERSISTENCE_FAILED" };
  } catch (error) {
    const retryable = isRetryable(error);
    const code = safeErrorCode(
      error,
      retryable ? "DELETION_RETRYABLE_FAILURE" : "DELETION_PERMANENT_FAILURE",
    );
    const outcome = await recordFailure(
      delivery,
      deletionEvent,
      options,
      code,
      retryable,
      "Environment deletion processing failed",
    );
    if (outcome === "DEAD_LETTER") return commit(record, options, "DEAD_LETTERED");
    if (outcome === "RETRY_SCHEDULED") {
      return { kind: "RETRY_SCHEDULED", committed: false, code };
    }
    return { kind: "FAILED", committed: false, code: "DELETION_FAILURE_PERSISTENCE_FAILED" };
  }
}

async function settlePermanentFailure(
  record: EnvironmentDeletionConsumerRecord,
  delivery: FeedbackDeliveryIdentity,
  options: EnvironmentDeletionConsumerOptions,
  code: string,
): Promise<EnvironmentDeletionConsumerOutcome> {
  try {
    const outcome = await options.deliveryRepository.recordDeadLetter({
      delivery,
      errorCode: normalizeErrorCode(code, "INVALID_DELETION_EVENT"),
      message: "Environment deletion event failed contract validation",
    });
    if (outcome.outcome === "DEAD_LETTER") return commit(record, options, "DEAD_LETTERED");
  } catch {
    return { kind: "FAILED", committed: false, code: "DELETION_DEAD_LETTER_FAILED" };
  }
  return { kind: "FAILED", committed: false, code: "DELETION_DEAD_LETTER_FAILED" };
}

async function recordFailure(
  delivery: FeedbackDeliveryIdentity,
  event: EnvironmentDeletionRequested,
  options: EnvironmentDeletionConsumerOptions,
  code: string,
  retryable: boolean,
  message: string,
): Promise<"RETRY_SCHEDULED" | "DEAD_LETTER" | "FAILED"> {
  try {
    const outcome = retryable
      ? await options.deliveryRepository.scheduleRetry({
          delivery,
          event: {
            eventId: event.eventId,
            eventType: event.eventType,
            environmentId: event.environmentId,
            aggregateId: event.environmentId,
          },
          errorCode: normalizeErrorCode(code, "DELETION_RETRYABLE_FAILURE"),
          message,
          ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
          ...(options.retryBaseDelayMs === undefined
            ? {}
            : { retryBaseDelayMs: options.retryBaseDelayMs }),
          ...(options.retryMaxDelayMs === undefined
            ? {}
            : { retryMaxDelayMs: options.retryMaxDelayMs }),
        })
      : await options.deliveryRepository.recordDeadLetter({
          delivery,
          event: {
            eventId: event.eventId,
            eventType: event.eventType,
            environmentId: event.environmentId,
            aggregateId: event.environmentId,
          },
          errorCode: normalizeErrorCode(code, "DELETION_PERMANENT_FAILURE"),
          message,
        });
    return outcome.outcome;
  } catch {
    return "FAILED";
  }
}

function createDeliveryIdentity(
  record: EnvironmentDeletionConsumerRecord,
  inspected: ReturnType<typeof inspectKafkaRecord>,
  consumerName: string,
): FeedbackDeliveryIdentity {
  const eventId =
    inspected.eventId.ok && isUuid(inspected.eventId.value) ? inspected.eventId.value : undefined;
  const eventType =
    inspected.eventType.ok && isEventType(inspected.eventType.value)
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

function commit(
  record: EnvironmentDeletionConsumerRecord,
  options: EnvironmentDeletionConsumerOptions,
  kind: "PROCESSED" | "ALREADY_PROCESSED" | "DEAD_LETTERED",
): Promise<EnvironmentDeletionConsumerOutcome> {
  return options.offsets
    .commitOffset({
      topic: record.topic,
      partition: record.partition,
      offset: nextOffset(record.offset),
    })
    .then(() => ({ kind, committed: true }) as EnvironmentDeletionConsumerOutcome)
    .catch(() => ({ kind: "FAILED", committed: false, code: "DELETION_OFFSET_COMMIT_FAILED" }));
}

function contractErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "INVALID_DELETION_EVENT";
}

function safeErrorCode(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : fallback;
}

function normalizeErrorCode(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : fallback;
}

function isRetryable(error: unknown): boolean {
  if (isRecord(error) && error.retryable === true) return true;
  if (!isRecord(error)) return false;
  return [
    "P2034",
    "40001",
    "40P01",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ].includes(String(error.code));
}

function isEventType(value: string): boolean {
  return /^[a-z][a-z0-9.-]{0,127}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
