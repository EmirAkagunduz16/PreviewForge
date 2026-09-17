import { type KafkaEvent, parseKafkaRecord } from "@previewforge/contracts";
import type {
  DeploymentFeedbackRepository,
  FeedbackDeliveryIdentity,
} from "@previewforge/database";
import type { KafkaMessage } from "kafkajs";
import { inspectKafkaRecord } from "../kafka/record.js";
import type { DeploymentFeedbackEvent, GitHubCheckRunCoordinator } from "./coordinator.js";

export type DeploymentFeedbackConsumerRecord = Pick<KafkaMessage, "key" | "headers" | "value"> & {
  topic: string;
  partition: number;
  offset: string;
};

export type DeploymentFeedbackConsumerOptions = {
  repository: Pick<
    DeploymentFeedbackRepository,
    "claimDelivery" | "markDeliveryProcessed" | "scheduleRetry" | "recordDeadLetter"
  >;
  coordinator: Pick<GitHubCheckRunCoordinator, "process">;
  consumerName: string;
  offsets: {
    commitOffset(input: { topic: string; partition: number; offset: string }): Promise<unknown>;
  };
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export type DeploymentFeedbackConsumerOutcome =
  | { kind: "PROCESSED" | "ALREADY_PROCESSED" | "DEAD_LETTERED"; committed: true }
  | { kind: "RETRY_SCHEDULED" | "RETRY_DEFERRED"; committed: false; code: string }
  | { kind: "FAILED"; committed: false; code: string };

const DEPLOYMENT_FEEDBACK_EVENTS = new Set([
  "deployment.requested.v1",
  "deployment.stage-changed.v1",
  "deployment.ready.v1",
  "deployment.failed.v1",
]);

export async function handleDeploymentFeedbackMessage(
  record: DeploymentFeedbackConsumerRecord,
  options: DeploymentFeedbackConsumerOptions,
): Promise<DeploymentFeedbackConsumerOutcome> {
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
  if (!DEPLOYMENT_FEEDBACK_EVENTS.has(event.eventType)) {
    return settlePermanentFailure(record, baseDelivery, options, "UNSUPPORTED_FEEDBACK_EVENT");
  }

  const feedbackEvent = event as DeploymentFeedbackEvent;
  const delivery = {
    ...baseDelivery,
    eventId: feedbackEvent.eventId,
    eventType: feedbackEvent.eventType,
    environmentId: feedbackEvent.environmentId,
    aggregateId: feedbackEvent.deploymentId,
  } satisfies FeedbackDeliveryIdentity;

  let claim: Awaited<ReturnType<DeploymentFeedbackRepository["claimDelivery"]>>;
  try {
    claim = await options.repository.claimDelivery(delivery);
  } catch {
    return { kind: "FAILED", committed: false, code: "FEEDBACK_DELIVERY_CLAIM_FAILED" };
  }
  if (claim.kind === "PROCESSED" || claim.kind === "DEAD_LETTER") {
    return commit(record, options, "ALREADY_PROCESSED");
  }
  if (claim.kind === "RETRY_NOT_DUE") {
    return { kind: "RETRY_DEFERRED", committed: false, code: "FEEDBACK_RETRY_NOT_DUE" };
  }

  try {
    await options.coordinator.process(feedbackEvent);
    await options.repository.markDeliveryProcessed(delivery);
    return commit(record, options, "PROCESSED");
  } catch (error) {
    const retryable = isRetryable(error);
    const code = safeErrorCode(
      error,
      retryable ? "CHECKS_RETRYABLE_FAILURE" : "CHECKS_PERMANENT_FAILURE",
    );
    const outcome = await recordFailure(delivery, feedbackEvent, options, code, retryable);
    if (outcome === "DEAD_LETTER") return commit(record, options, "DEAD_LETTERED");
    if (outcome === "RETRY_SCHEDULED") {
      return { kind: "RETRY_SCHEDULED", committed: false, code };
    }
    return { kind: "FAILED", committed: false, code: "FEEDBACK_FAILURE_PERSISTENCE_FAILED" };
  }
}

async function settlePermanentFailure(
  record: DeploymentFeedbackConsumerRecord,
  delivery: FeedbackDeliveryIdentity,
  options: DeploymentFeedbackConsumerOptions,
  code: string,
): Promise<DeploymentFeedbackConsumerOutcome> {
  try {
    const outcome = await options.repository.recordDeadLetter({
      delivery,
      errorCode: normalizeErrorCode(code, "INVALID_FEEDBACK_EVENT"),
      message: "GitHub feedback event failed contract validation",
    });
    if (outcome.outcome === "DEAD_LETTER") return commit(record, options, "DEAD_LETTERED");
  } catch {
    return { kind: "FAILED", committed: false, code: "FEEDBACK_DEAD_LETTER_FAILED" };
  }
  return { kind: "FAILED", committed: false, code: "FEEDBACK_DEAD_LETTER_FAILED" };
}

async function recordFailure(
  delivery: FeedbackDeliveryIdentity,
  event: DeploymentFeedbackEvent,
  options: DeploymentFeedbackConsumerOptions,
  code: string,
  retryable: boolean,
): Promise<"RETRY_SCHEDULED" | "DEAD_LETTER" | "FAILED"> {
  try {
    const outcome = retryable
      ? await options.repository.scheduleRetry({
          delivery,
          event: {
            eventId: event.eventId,
            eventType: event.eventType,
            environmentId: event.environmentId,
            aggregateId: event.deploymentId,
          },
          errorCode: normalizeErrorCode(code, "CHECKS_RETRYABLE_FAILURE"),
          message: "GitHub Check Run update failed and will be retried",
          ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
          ...(options.retryBaseDelayMs === undefined
            ? {}
            : { retryBaseDelayMs: options.retryBaseDelayMs }),
          ...(options.retryMaxDelayMs === undefined
            ? {}
            : { retryMaxDelayMs: options.retryMaxDelayMs }),
        })
      : await options.repository.recordDeadLetter({
          delivery,
          event: {
            eventId: event.eventId,
            eventType: event.eventType,
            environmentId: event.environmentId,
            aggregateId: event.deploymentId,
          },
          errorCode: normalizeErrorCode(code, "CHECKS_PERMANENT_FAILURE"),
          message: "GitHub Check Run update was rejected permanently",
        });
    return outcome.outcome;
  } catch {
    return "FAILED";
  }
}

function createDeliveryIdentity(
  record: DeploymentFeedbackConsumerRecord,
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
  record: DeploymentFeedbackConsumerRecord,
  options: DeploymentFeedbackConsumerOptions,
  kind: "PROCESSED" | "ALREADY_PROCESSED" | "DEAD_LETTERED",
): Promise<DeploymentFeedbackConsumerOutcome> {
  return options.offsets
    .commitOffset({
      topic: record.topic,
      partition: record.partition,
      offset: nextOffset(record.offset),
    })
    .then(() => ({ kind, committed: true }) as DeploymentFeedbackConsumerOutcome)
    .catch(() => ({ kind: "FAILED", committed: false, code: "FEEDBACK_OFFSET_COMMIT_FAILED" }));
}

function contractErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "INVALID_FEEDBACK_EVENT";
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
