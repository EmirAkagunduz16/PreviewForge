import { describe, expect, it } from "vitest";
import {
  KafkaContractError,
  kafkaTopics,
  normalizeOutboxEvent,
  parseKafkaEvent,
  parseKafkaRecord,
  topicForEventType,
} from "../src/kafka.js";

const ids = {
  event: "019930c0-c522-7474-a3f0-1ee461901c20",
  deployment: "019930c0-c522-7474-a3f0-1ee461901c21",
  environment: "019930c0-c522-7474-a3f0-1ee461901c22",
  project: "019930c0-c522-7474-a3f0-1ee461901c23",
  pullRequest: "019930c0-c522-7474-a3f0-1ee461901c24",
};

const requested = {
  eventId: ids.event,
  eventType: "deployment.requested.v1" as const,
  occurredAt: "2026-09-12T17:00:00.000Z",
  deploymentId: ids.deployment,
  environmentId: ids.environment,
  projectId: ids.project,
  installationId: "42",
  repositoryFullName: "acme/store",
  pullRequestNumber: 7,
  commitSha: "7dc12ab7dc12ab7dc12ab7dc12ab7dc12ab7dc12",
};

const stageChanged = {
  eventId: ids.event,
  eventType: "deployment.stage-changed.v1" as const,
  occurredAt: "2026-09-12T17:00:00.000Z",
  deploymentId: ids.deployment,
  environmentId: ids.environment,
  commitSha: requested.commitSha,
  fromStatus: "QUEUED" as const,
  toStatus: "CLONING" as const,
};

function row(event: Record<string, unknown>, eventType = event.eventType) {
  const isDeletion = eventType === "environment.deletion-requested.v1";
  return {
    id: event.eventId,
    eventType,
    aggregateType: isDeletion ? "environment" : "deployment",
    aggregateId: isDeletion ? event.environmentId : event.deploymentId,
    payload: event,
  };
}

function record(event: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const eventId = String(event.eventId);
  const eventType = String(event.eventType);
  const topic = topicForEventType(eventType as Parameters<typeof topicForEventType>[0]);
  return {
    topic,
    key: event.environmentId,
    value: JSON.stringify(event),
    headers: { "event-id": eventId, "event-type": eventType },
    ...overrides,
  };
}

function expectContractCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected contract parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(KafkaContractError);
    expect((error as KafkaContractError).code).toBe(code);
  }
}

describe("Kafka event contracts", () => {
  it("routes every allow-listed event type to its planned topic", () => {
    expect(topicForEventType("deployment.requested.v1")).toBe(kafkaTopics.deploymentRequests);
    expect(topicForEventType("deployment.stage-changed.v1")).toBe(kafkaTopics.deploymentEvents);
    expect(topicForEventType("deployment.ready.v1")).toBe(kafkaTopics.deploymentEvents);
    expect(topicForEventType("deployment.failed.v1")).toBe(kafkaTopics.deploymentEvents);
    expect(topicForEventType("environment.deletion-requested.v1")).toBe(
      kafkaTopics.environmentCommands,
    );
  });

  it("normalizes an outbox row and strips unknown payload fields", () => {
    const normalized = normalizeOutboxEvent({
      ...row({ ...requested, accidentalSecret: "must-not-cross-boundary" }),
      attempts: 3,
      publishedAt: null,
    });

    expect(normalized).toMatchObject({
      rowId: ids.event,
      topic: kafkaTopics.deploymentRequests,
      key: ids.environment,
      headers: { "event-id": ids.event, "event-type": requested.eventType },
    });
    expect(normalized.value).not.toContain("accidentalSecret");
    expect(normalized.value).not.toContain("must-not-cross-boundary");
  });

  it("propagates only a validated traceparent through outbox and Kafka headers", () => {
    const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
    const normalized = normalizeOutboxEvent({ ...row(requested), traceParent: traceparent });
    expect(normalized.headers.traceparent).toBe(traceparent);
    expect(
      parseKafkaRecord(
        record(requested, {
          headers: { ...normalized.headers },
        }),
      ).headers.traceparent,
    ).toBe(traceparent);
    expectContractCode(
      () => normalizeOutboxEvent({ ...row(requested), traceParent: "00-0" }),
      "INVALID_OUTBOX_ROW",
    );
  });

  it("accepts all current event payload variants", () => {
    const ready = {
      ...stageChanged,
      eventId: ids.event,
      eventType: "deployment.ready.v1" as const,
      fromStatus: "WAITING_FOR_HEALTHCHECK" as const,
      toStatus: "READY" as const,
    };
    const failed = {
      ...stageChanged,
      eventId: ids.event,
      eventType: "deployment.failed.v1" as const,
      toStatus: "FAILED" as const,
      failure: {
        stage: "BUILDING",
        code: "BUILD_FAILED",
        message: "Dockerfile failed",
        retryable: false,
      },
    };
    const deletion = {
      eventId: ids.event,
      eventType: "environment.deletion-requested.v1" as const,
      occurredAt: "2026-09-12T17:00:00.000Z",
      environmentId: ids.environment,
      sourceTimestamp: "2026-09-12T16:59:00.000Z",
      projectId: ids.project,
      pullRequestId: ids.pullRequest,
      pullRequestNumber: 7,
      repositoryId: "99",
      repositoryFullName: "acme/store",
      installationId: "42",
      reason: "pull_request_closed" as const,
    };
    const ttlDeletion = { ...deletion, reason: "ttl_expired" as const };

    expect(parseKafkaEvent(requested).eventType).toBe("deployment.requested.v1");
    expect(parseKafkaEvent(stageChanged).eventType).toBe("deployment.stage-changed.v1");
    expect(parseKafkaEvent(ready).eventType).toBe("deployment.ready.v1");
    expect(parseKafkaEvent(failed).eventType).toBe("deployment.failed.v1");
    expect(parseKafkaEvent(deletion).eventType).toBe("environment.deletion-requested.v1");
    expect(parseKafkaEvent(ttlDeletion)).toMatchObject({ reason: "ttl_expired" });
  });

  it("normalizes a Kafka record and strips unknown headers and payload fields", () => {
    const parsed = parseKafkaRecord(
      record(
        { ...requested, accidentalSecret: "must-not-cross-boundary" },
        {
          headers: {
            "event-id": ids.event,
            "event-type": requested.eventType,
            "unknown-header": "ignored",
          },
        },
      ),
    );

    expect(parsed.event).not.toHaveProperty("accidentalSecret");
    expect(parsed.headers).toEqual({ "event-id": ids.event, "event-type": requested.eventType });
    expect(parsed.value).not.toContain("unknown-header");
    expect(parsed.value).not.toContain("must-not-cross-boundary");
  });

  it("rejects a row ID that differs from payload eventId", () => {
    expectContractCode(
      () => normalizeOutboxEvent({ ...row(requested), id: ids.deployment }),
      "EVENT_IDENTITY_MISMATCH",
    );
  });

  it("rejects a row event type that differs from payload eventType", () => {
    expectContractCode(
      () => normalizeOutboxEvent(row(requested, "deployment.failed.v1")),
      "EVENT_TYPE_IDENTITY_MISMATCH",
    );
  });

  it("rejects an outbox row with the wrong aggregate identity", () => {
    expectContractCode(
      () => normalizeOutboxEvent({ ...row(requested), aggregateId: ids.environment }),
      "AGGREGATE_IDENTITY_MISMATCH",
    );
    expectContractCode(
      () => normalizeOutboxEvent({ ...row(requested), aggregateType: "environment" }),
      "AGGREGATE_IDENTITY_MISMATCH",
    );
  });

  it("rejects illegal state-map transitions for stage, ready, and failed events", () => {
    expectContractCode(
      () =>
        parseKafkaEvent({
          ...stageChanged,
          fromStatus: "READY",
          toStatus: "QUEUED",
        }),
      "INVALID_EVENT_PAYLOAD",
    );
    expectContractCode(
      () =>
        parseKafkaEvent({
          ...stageChanged,
          eventType: "deployment.ready.v1",
          fromStatus: "QUEUED",
          toStatus: "READY",
        }),
      "INVALID_EVENT_PAYLOAD",
    );
    expectContractCode(
      () =>
        parseKafkaEvent({
          ...stageChanged,
          eventType: "deployment.failed.v1",
          fromStatus: "FAILED",
          toStatus: "FAILED",
          failure: {
            stage: "BUILDING",
            code: "BUILD_FAILED",
            message: "deterministic failure",
            retryable: false,
          },
        }),
      "INVALID_EVENT_PAYLOAD",
    );
  });

  it("rejects a topic that does not match the versioned event type", () => {
    expectContractCode(
      () => parseKafkaRecord(record(requested, { topic: kafkaTopics.deploymentEvents })),
      "TOPIC_IDENTITY_MISMATCH",
    );
  });

  it("rejects a Kafka key that does not match environmentId", () => {
    expectContractCode(
      () => parseKafkaRecord(record(requested, { key: ids.project })),
      "KEY_IDENTITY_MISMATCH",
    );
  });

  it("rejects headers that do not match payload identity", () => {
    expectContractCode(
      () =>
        parseKafkaRecord(
          record(requested, {
            headers: { "event-id": ids.deployment, "event-type": requested.eventType },
          }),
        ),
      "HEADER_IDENTITY_MISMATCH",
    );
  });

  it("rejects unsupported versions and malformed JSON", () => {
    expectContractCode(
      () => parseKafkaEvent({ ...requested, eventType: "deployment.requested.v2" }),
      "INVALID_EVENT_PAYLOAD",
    );
    expectContractCode(
      () => parseKafkaRecord(record(requested, { value: "{not-json" })),
      "INVALID_JSON",
    );
  });

  it("rejects malformed identities instead of persisting raw input", () => {
    expectContractCode(
      () => parseKafkaRecord(record({ ...requested, environmentId: "not-a-uuid" })),
      "INVALID_EVENT_PAYLOAD",
    );
    expectContractCode(
      () =>
        parseKafkaRecord({
          ...record(requested),
          value: new Uint8Array([0xff, 0xfe]),
        }),
      "INVALID_KAFKA_RECORD",
    );
  });
});
