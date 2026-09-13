import { z } from "zod";
import {
  canTransitionDeployment,
  deploymentRequestedSchema,
  deploymentStatusSchema,
} from "./deployment.js";
import { environmentDeletionRequestedSchema } from "./github.js";

export const kafkaTopics = {
  deploymentRequests: "previewforge.deployment-requests.v1",
  deploymentEvents: "previewforge.deployment-events.v1",
  environmentCommands: "previewforge.environment-commands.v1",
} as const;

export type KafkaTopic = (typeof kafkaTopics)[keyof typeof kafkaTopics];

export const kafkaEventTypes = [
  "deployment.requested.v1",
  "deployment.stage-changed.v1",
  "deployment.ready.v1",
  "deployment.failed.v1",
  "environment.deletion-requested.v1",
] as const;

export const kafkaEventTypeSchema = z.enum(kafkaEventTypes);
export type KafkaEventType = (typeof kafkaEventTypes)[number];

const uuid = z.uuid();
const isoDateTime = z.iso.datetime();
const commitSha = z.string().regex(/^[0-9a-f]{40}$/i);
const eventIdentitySchema = z.object({
  eventId: uuid,
  eventType: kafkaEventTypeSchema,
  occurredAt: isoDateTime,
  environmentId: uuid,
});

const deploymentTransitionSchema = eventIdentitySchema.extend({
  deploymentId: uuid,
  commitSha,
  fromStatus: deploymentStatusSchema,
  toStatus: deploymentStatusSchema,
});

const deploymentStageChangedSchema = deploymentTransitionSchema
  .extend({
    eventType: z.literal("deployment.stage-changed.v1"),
  })
  .superRefine(assertLegalTransition);

const deploymentReadySchema = deploymentTransitionSchema
  .extend({
    eventType: z.literal("deployment.ready.v1"),
    toStatus: z.literal("READY"),
  })
  .superRefine(assertLegalTransition);

const deploymentFailureSchema = z.object({
  stage: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

const deploymentFailedSchema = deploymentTransitionSchema
  .extend({
    eventType: z.literal("deployment.failed.v1"),
    toStatus: z.literal("FAILED"),
    failure: deploymentFailureSchema,
  })
  .superRefine(assertLegalTransition);

/**
 * All event payloads that may cross the Kafka boundary. Zod's default object
 * mode strips unknown fields, so a normalized event can never carry an
 * accidental field from an outbox row or an untrusted Kafka record.
 */
export const kafkaEventSchema = z.union([
  deploymentRequestedSchema,
  deploymentStageChangedSchema,
  deploymentReadySchema,
  deploymentFailedSchema,
  environmentDeletionRequestedSchema,
]);

export type KafkaEvent = z.infer<typeof kafkaEventSchema>;
export type DeploymentStageChanged = z.infer<typeof deploymentStageChangedSchema>;
export type DeploymentReady = z.infer<typeof deploymentReadySchema>;
export type DeploymentFailed = z.infer<typeof deploymentFailedSchema>;

export type KafkaOutboxRow = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
};

export type KafkaRecordInput = {
  topic: unknown;
  key: unknown;
  value: unknown;
  headers?: unknown;
};

export type NormalizedKafkaMessage = {
  rowId?: string;
  topic: KafkaTopic;
  key: string;
  value: string;
  headers: {
    "event-id": string;
    "event-type": KafkaEventType;
  };
  event: KafkaEvent;
};

export type KafkaContractErrorCode =
  | "INVALID_OUTBOX_ROW"
  | "INVALID_EVENT_PAYLOAD"
  | "INVALID_KAFKA_RECORD"
  | "INVALID_JSON"
  | "EVENT_IDENTITY_MISMATCH"
  | "EVENT_TYPE_IDENTITY_MISMATCH"
  | "TOPIC_IDENTITY_MISMATCH"
  | "HEADER_IDENTITY_MISMATCH"
  | "KEY_IDENTITY_MISMATCH"
  | "AGGREGATE_IDENTITY_MISMATCH";

export class KafkaContractError extends Error {
  constructor(
    readonly code: KafkaContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KafkaContractError";
  }
}

export function topicForEventType(eventType: KafkaEventType): KafkaTopic {
  switch (eventType) {
    case "deployment.requested.v1":
      return kafkaTopics.deploymentRequests;
    case "deployment.stage-changed.v1":
    case "deployment.ready.v1":
    case "deployment.failed.v1":
      return kafkaTopics.deploymentEvents;
    case "environment.deletion-requested.v1":
      return kafkaTopics.environmentCommands;
  }
}

export function parseKafkaEvent(value: unknown): KafkaEvent {
  const result = kafkaEventSchema.safeParse(value);
  if (!result.success) {
    throw new KafkaContractError("INVALID_EVENT_PAYLOAD", "Kafka event payload is invalid");
  }
  return result.data;
}

export function normalizeOutboxEvent(row: unknown): NormalizedKafkaMessage {
  const parsedRow = parseOutboxRow(row);
  const event = parseKafkaEvent(parsedRow.payload);
  if (parsedRow.id !== event.eventId) {
    throw new KafkaContractError(
      "EVENT_IDENTITY_MISMATCH",
      "Outbox row ID does not match payload eventId",
    );
  }
  if (parsedRow.eventType !== event.eventType) {
    throw new KafkaContractError(
      "EVENT_TYPE_IDENTITY_MISMATCH",
      "Outbox row eventType does not match payload eventType",
    );
  }
  const expectedAggregateType =
    event.eventType === "environment.deletion-requested.v1" ? "environment" : "deployment";
  const expectedAggregateId =
    event.eventType === "environment.deletion-requested.v1"
      ? event.environmentId
      : event.deploymentId;
  if (
    parsedRow.aggregateType !== expectedAggregateType ||
    parsedRow.aggregateId !== expectedAggregateId
  ) {
    throw new KafkaContractError(
      "AGGREGATE_IDENTITY_MISMATCH",
      "Outbox aggregate identity does not match payload",
    );
  }

  const topic = topicForEventType(event.eventType);
  return {
    rowId: parsedRow.id,
    topic,
    key: event.environmentId,
    value: JSON.stringify(event),
    headers: {
      "event-id": event.eventId,
      "event-type": event.eventType,
    },
    event,
  };
}

export function parseKafkaRecord(record: KafkaRecordInput): NormalizedKafkaMessage {
  const topic = parseTopic(record.topic);
  const key = decodeValue(record.key, "key");
  const event = parseKafkaEvent(parseJsonValue(record.value));

  if (topicForEventType(event.eventType) !== topic) {
    throw new KafkaContractError(
      "TOPIC_IDENTITY_MISMATCH",
      "Kafka topic does not match payload eventType",
    );
  }
  if (key !== event.environmentId) {
    throw new KafkaContractError(
      "KEY_IDENTITY_MISMATCH",
      "Kafka key does not match payload environmentId",
    );
  }

  const headers = parseHeaders(record.headers);
  if (headers["event-id"] !== event.eventId || headers["event-type"] !== event.eventType) {
    throw new KafkaContractError(
      "HEADER_IDENTITY_MISMATCH",
      "Kafka headers do not match payload identity",
    );
  }

  return {
    topic,
    key,
    value: JSON.stringify(event),
    headers,
    event,
  };
}

function parseOutboxRow(value: unknown): KafkaOutboxRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.eventType !== "string" ||
    typeof value.aggregateType !== "string" ||
    typeof value.aggregateId !== "string"
  ) {
    throw new KafkaContractError("INVALID_OUTBOX_ROW", "Outbox row identity is invalid");
  }
  const id = uuid.safeParse(value.id);
  const eventType = kafkaEventTypeSchema.safeParse(value.eventType);
  const aggregateId = uuid.safeParse(value.aggregateId);
  if (
    !id.success ||
    !eventType.success ||
    !aggregateId.success ||
    !Object.hasOwn(value, "payload")
  ) {
    throw new KafkaContractError("INVALID_OUTBOX_ROW", "Outbox row identity is invalid");
  }
  return {
    id: id.data,
    eventType: eventType.data,
    aggregateType: value.aggregateType,
    aggregateId: aggregateId.data,
    payload: value.payload,
  };
}

function assertLegalTransition(
  value: {
    fromStatus: z.infer<typeof deploymentStatusSchema>;
    toStatus: z.infer<typeof deploymentStatusSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (!canTransitionDeployment(value.fromStatus, value.toStatus)) {
    context.addIssue({
      code: "custom",
      message: `illegal deployment transition ${value.fromStatus} -> ${value.toStatus}`,
    });
  }
}

function parseTopic(value: unknown): KafkaTopic {
  if (typeof value !== "string" || !Object.values(kafkaTopics).includes(value as KafkaTopic)) {
    throw new KafkaContractError("INVALID_KAFKA_RECORD", "Kafka topic is invalid");
  }
  return value as KafkaTopic;
}

function parseHeaders(value: unknown): NormalizedKafkaMessage["headers"] {
  if (!isRecord(value)) {
    throw new KafkaContractError("INVALID_KAFKA_RECORD", "Kafka headers are missing");
  }
  const eventId = decodeHeader(value["event-id"]);
  const eventType = decodeHeader(value["event-type"]);
  const parsedEventId = uuid.safeParse(eventId);
  const parsedEventType = kafkaEventTypeSchema.safeParse(eventType);
  if (!parsedEventId.success || !parsedEventType.success) {
    throw new KafkaContractError("INVALID_KAFKA_RECORD", "Kafka header identity is invalid");
  }
  return { "event-id": parsedEventId.data, "event-type": parsedEventType.data };
}

function decodeHeader(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new KafkaContractError("INVALID_KAFKA_RECORD", "Kafka header must contain one value");
    }
    return decodeValue(value[0], "header");
  }
  return decodeValue(value, "header");
}

function decodeValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw new KafkaContractError("INVALID_KAFKA_RECORD", `Kafka ${label} is not valid UTF-8`);
    }
  }
  throw new KafkaContractError("INVALID_KAFKA_RECORD", `Kafka ${label} is missing or invalid`);
}

function parseJsonValue(value: unknown): unknown {
  const text = decodeValue(value, "value");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KafkaContractError("INVALID_JSON", "Kafka value is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
