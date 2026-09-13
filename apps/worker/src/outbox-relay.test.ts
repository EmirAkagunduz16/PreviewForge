import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  OutboxRelayFailureInput,
  OutboxRelayFailureResult,
  OutboxRelayProducer,
  OutboxRelayPublishResult,
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
    attempts: 0,
    claimToken: randomUUID(),
    ...overrides,
  };
}

class FakeRepository implements OutboxRelayRepository {
  readonly claims: Array<{
    limit: number;
    owner: string;
    leaseDurationMs?: number;
    maxAttempts?: number;
  }> = [];
  readonly published: Array<{ id: string; claimToken: string }> = [];
  readonly failures: OutboxRelayFailureInput[] = [];
  rows: OutboxRelayRow[] = [];
  markPublishedError: unknown;
  recordFailureError: unknown;
  markPublishedOutcome: OutboxRelayPublishResult["outcome"] = "PUBLISHED";
  recordFailureOutcome?: OutboxRelayFailureResult["outcome"];

  async claimBatch(input: {
    limit: number;
    owner: string;
    leaseDurationMs?: number;
    maxAttempts?: number;
  }): Promise<readonly OutboxRelayRow[]> {
    this.claims.push(input);
    const selected = this.rows.slice(0, input.limit);
    const selectedIds = new Set(selected.map((row) => row.id));
    this.rows = this.rows.map((row) =>
      selectedIds.has(row.id) ? { ...row, attempts: row.attempts + 1 } : row,
    );
    return selected.map((row) => ({ ...row, attempts: row.attempts + 1 }));
  }

  async markPublished(id: string, claimToken: string): Promise<OutboxRelayPublishResult> {
    if (this.markPublishedError !== undefined) throw this.markPublishedError;
    if (this.markPublishedOutcome === "PUBLISHED") {
      this.published.push({ id, claimToken });
      this.rows = this.rows.filter((row) => row.id !== id);
    }
    return { outcome: this.markPublishedOutcome };
  }

  async recordFailure(input: OutboxRelayFailureInput): Promise<OutboxRelayFailureResult> {
    if (this.recordFailureError !== undefined) throw this.recordFailureError;
    this.failures.push(input);
    return {
      outcome:
        this.recordFailureOutcome ?? (input.failure.retryable ? "RETRY_SCHEDULED" : "DEAD_LETTER"),
    };
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
    expect(repository.claims[0]?.leaseDurationMs).toBe(30_000);
    expect(repository.claims[0]?.maxAttempts).toBe(5);
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

  it("treats an ambiguous generic producer error as retryable and never marks the row", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();
    producer.sendError = new Error("post-write connection closed: bearer very-secret-token");

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({
      published: 0,
      retryableFailures: 1,
      deadLettered: 0,
      failed: 0,
    });
    expect(repository.published).toHaveLength(0);
    expect(repository.failures[0]).toMatchObject({
      failure: {
        code: "KAFKA_TRANSPORT_RETRYABLE",
        message: "Kafka transport failure; retry scheduled",
        retryable: true,
      },
    });
    expect(JSON.stringify(repository.failures)).not.toContain("very-secret-token");
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

  it("counts an already-published settlement separately", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    repository.markPublishedOutcome = "ALREADY_PUBLISHED";
    const producer = new FakeProducer();

    const result = await relayOutboxBatch(repository, producer, { owner: "relay-1" });

    expect(result).toMatchObject({ published: 0, alreadyPublished: 1, failed: 0 });
    expect(repository.published).toHaveLength(0);
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

  it("uses the durable failure outcome for retry exhaustion metrics", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();
    producer.sendError = new Error("connection closed after broker write");
    repository.recordFailureOutcome = "DEAD_LETTER";

    const result = await relayOutboxBatch(repository, producer, {
      owner: "relay-1",
      maxAttempts: 2,
    });

    expect(result).toMatchObject({ claimed: 1, deadLettered: 1, retryableFailures: 0 });
    expect(repository.failures).toEqual([
      expect.objectContaining({
        failure: {
          code: "KAFKA_TRANSPORT_RETRYABLE",
          message: "Kafka transport failure; retry scheduled",
          retryable: true,
        },
      }),
    ]);
  });

  it("passes bounded exponential retry delays and lease options", async () => {
    const repository = new FakeRepository();
    const producer = new FakeProducer();
    producer.sendError = new Error("temporary connection failure");
    repository.rows = [row({ attempts: 0 })];

    await relayOutboxBatch(repository, producer, {
      owner: "relay-1",
      leaseDurationMs: 2_500,
      maxAttempts: 7,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 250,
      random: () => 0,
    });
    await relayOutboxBatch(repository, producer, {
      owner: "relay-1",
      leaseDurationMs: 2_500,
      maxAttempts: 7,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 250,
      random: () => 0,
    });
    await relayOutboxBatch(repository, producer, {
      owner: "relay-1",
      leaseDurationMs: 2_500,
      maxAttempts: 7,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 250,
      random: () => 0,
    });

    expect(repository.claims.map((claim) => claim.leaseDurationMs)).toEqual([2_500, 2_500, 2_500]);
    expect(repository.claims.map((claim) => claim.maxAttempts)).toEqual([7, 7, 7]);
    expect(repository.failures.map((failure) => failure.retryDelayMs)).toEqual([100, 200, 250]);
    expect(repository.failures.every((failure) => failure.maxAttempts === 7)).toBe(true);
  });

  it("fails closed when claim attempts are not reserved within the configured budget", async () => {
    const producer = new FakeProducer();
    const belowMinimum = new FakeRepository();
    belowMinimum.rows = [row({ attempts: -1 })];

    const belowResult = await relayOutboxBatch(belowMinimum, producer, {
      owner: "relay-1",
      maxAttempts: 2,
    });

    expect(belowResult).toMatchObject({ claimed: 1, failed: 1, published: 0 });
    expect(producer.sends).toHaveLength(0);
    expect(belowMinimum.failures).toHaveLength(0);

    const aboveMaximum = new FakeRepository();
    aboveMaximum.rows = [row({ attempts: 2 })];

    const aboveResult = await relayOutboxBatch(aboveMaximum, producer, {
      owner: "relay-1",
      maxAttempts: 2,
    });

    expect(aboveResult).toMatchObject({ claimed: 1, failed: 1, published: 0 });
    expect(producer.sends).toHaveLength(0);
    expect(aboveMaximum.failures).toHaveLength(0);
  });

  it("rejects unbounded relay options", async () => {
    const repository = new FakeRepository();
    repository.rows = [row()];
    const producer = new FakeProducer();

    await expect(
      relayOutboxBatch(repository, producer, { owner: "relay-1", leaseDurationMs: 0 }),
    ).rejects.toThrow("Invalid outbox lease duration");
    await expect(
      relayOutboxBatch(repository, producer, {
        owner: "relay-1",
        retryBaseDelayMs: 200,
        retryMaxDelayMs: 100,
      }),
    ).rejects.toThrow("retry base delay cannot exceed retry maximum delay");
  });
});
