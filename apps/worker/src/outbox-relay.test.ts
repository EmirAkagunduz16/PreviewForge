import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  OutboxRelayFailureInput,
  OutboxRelayProducer,
  OutboxRelayRepository,
  OutboxRelayRow,
} from "./outbox-relay.js";
import { relayOutboxBatch } from "./outbox-relay.js";

const ids = {
  event: "019930c0-c522-7474-a3f0-1ee461901c20",
  deployment: "019930c0-c522-7474-a3f0-1ee461901c21",
  environment: "019930c0-c522-7474-a3f0-1ee461901c22",
  project: "019930c0-c522-7474-a3f0-1ee461901c23",
};

const requestedEvent = {
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

function row(overrides: Partial<OutboxRelayRow> = {}): OutboxRelayRow {
  return {
    id: ids.event,
    eventType: requestedEvent.eventType,
    aggregateType: "deployment",
    aggregateId: ids.deployment,
    payload: requestedEvent,
    claimToken: randomUUID(),
    ...overrides,
  };
}

class FakeRepository implements OutboxRelayRepository {
  readonly claims: Array<{ limit: number; owner: string }> = [];
  readonly published: Array<{ id: string; claimToken: string }> = [];
  readonly failures: OutboxRelayFailureInput[] = [];
  rows: OutboxRelayRow[] = [];
  markPublishedError: unknown;
  recordFailureError: unknown;

  async claimBatch(input: { limit: number; owner: string }): Promise<readonly OutboxRelayRow[]> {
    this.claims.push(input);
    return this.rows.slice(0, input.limit);
  }

  async markPublished(id: string, claimToken: string): Promise<void> {
    if (this.markPublishedError !== undefined) throw this.markPublishedError;
    this.published.push({ id, claimToken });
    this.rows = this.rows.filter((row) => row.id !== id);
  }

  async recordFailure(input: OutboxRelayFailureInput): Promise<void> {
    if (this.recordFailureError !== undefined) throw this.recordFailureError;
    this.failures.push(input);
  }
}

class FakeProducer implements OutboxRelayProducer {
  readonly sends: Array<Parameters<OutboxRelayProducer["send"]>[0]> = [];
  sendError: unknown;
  sendStarted?: () => void;
  sendGate?: Promise<void>;

  async send(options: Parameters<OutboxRelayProducer["send"]>[0]): Promise<void> {
    this.sends.push(options);
    this.sendStarted?.();
    if (this.sendError !== undefined) throw this.sendError;
    if (this.sendGate !== undefined) await this.sendGate;
  }
}

describe("relayOutboxBatch", () => {
  it("waits for broker acknowledgement before marking published", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();
    let resolveAck!: () => void;
    producer.sendGate = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });

    const relay = relayOutboxBatch(repository, producer, { owner: "relay-1" });
    await vi.waitFor(() => expect(producer.sends).toHaveLength(1));

    expect(repository.published).toHaveLength(0);
    resolveAck();
    const result = await relay;

    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(repository.published).toHaveLength(1);
    expect(producer.sends[0]?.acks).toBe(-1);
    expect(producer.sends[0]?.topic).toBe("previewforge.deployment-requests.v1");
    expect(producer.sends[0]?.messages[0]).toMatchObject({
      key: ids.environment,
      value: JSON.stringify(requestedEvent),
      headers: { "event-id": ids.event, "event-type": requestedEvent.eventType },
    });
  });

  it("records a retryable transport failure and never marks the row", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();
    producer.sendError = { name: "KafkaJSConnectionError", message: "secret broker detail" };

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1", batchSize: 1 });

    expect(result).toMatchObject({ claimed: 1, published: 0, retryableFailures: 1, failed: 0 });
    expect(repository.published).toHaveLength(0);
    expect(repository.failures).toEqual([
      expect.objectContaining({
        failure: {
          code: "KAFKA_TRANSPORT_RETRYABLE",
          message: "Kafka transport failure; retry scheduled",
          retryable: true,
        },
      }),
    ]);
    expect(JSON.stringify(repository.failures)).not.toContain("secret broker detail");
  });

  it("classifies an explicitly typed transient network error as retryable", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();
    producer.sendError = { code: "ECONNRESET", message: "socket detail" };

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({ retryableFailures: 1, deadLettered: 0, failed: 0 });
    expect(repository.failures[0]).toMatchObject({
      failure: {
        code: "KAFKA_TRANSPORT_RETRYABLE",
        retryable: true,
      },
    });
  });

  it("dead-letters an invalid contract row without sending it", async () => {
    const repository = new FakeRepository();
    repository.rows = [row({ payload: { eventId: "not-an-event" } })];
    const producer = new FakeProducer();

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({ claimed: 1, published: 0, deadLettered: 1, failed: 0 });
    expect(producer.sends).toHaveLength(0);
    expect(repository.failures).toEqual([
      expect.objectContaining({
        failure: {
          code: "INVALID_EVENT_PAYLOAD",
          message: "Kafka outbox contract validation failed",
          retryable: false,
        },
      }),
    ]);
  });

  it("fails closed when a claimed row has no claim token", async () => {
    const repository = new FakeRepository();
    repository.rows = [row({ claimToken: null })];
    const producer = new FakeProducer();

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({ claimed: 1, failed: 1, missingClaims: 1, published: 0 });
    expect(producer.sends).toHaveLength(0);
    expect(repository.published).toHaveLength(0);
    expect(repository.failures).toHaveLength(0);
  });

  it("surfaces a post-ack mark failure as reclaimable without recording a stale-token failure", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    repository.markPublishedError = { code: "OUTBOX_CLAIM_LOST", message: "claim token expired" };
    const producer = new FakeProducer();

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1, staleClaims: 1 });
    expect(repository.failures).toHaveLength(0);
    expect(producer.sends).toHaveLength(1);

    repository.markPublishedError = undefined;
    const reclaimed = await relayOutboxBatch(repository, producer, { owner: "relay-2" });
    expect(reclaimed).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(repository.rows).toHaveLength(0);
  });

  it("continues after a poison row and publishes a following valid row", async () => {
    const repository = new FakeRepository();
    const valid = row({
      id: ids.deployment,
      payload: { ...requestedEvent, eventId: ids.deployment },
    });
    repository.rows = [row({ payload: { secret: "poison" } }), valid];
    const producer = new FakeProducer();

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1", batchSize: 2 });

    expect(result).toMatchObject({ claimed: 2, deadLettered: 1, published: 1, failed: 0 });
    expect(producer.sends).toHaveLength(1);
    expect(repository.published).toEqual([{ id: ids.deployment, claimToken: valid.claimToken }]);
    expect(JSON.stringify(repository.failures)).not.toContain("poison");
  });

  it("classifies unknown failures as non-retryable and redacted", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();
    producer.sendError = new Error("authorization: Bearer very-secret-token");

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({ claimed: 1, deadLettered: 1, retryableFailures: 0 });
    expect(repository.failures).toEqual([
      expect.objectContaining({
        failure: {
          code: "OUTBOX_RELAY_FAILED",
          message: "Outbox relay failed with an unclassified error",
          retryable: false,
        },
      }),
    ]);
    expect(JSON.stringify(repository.failures)).not.toContain("very-secret-token");
  });
});
