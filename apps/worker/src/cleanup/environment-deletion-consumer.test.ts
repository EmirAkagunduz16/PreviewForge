import type {
  DeploymentFeedbackRepository,
  EnvironmentDeletionRepository,
  FeedbackDeliveryClaim,
  FeedbackDeliveryOutcome,
} from "@previewforge/database";
import { describe, expect, it } from "vitest";
import {
  type EnvironmentDeletionConsumerRecord,
  handleEnvironmentDeletionMessage,
} from "./environment-deletion-consumer.js";

const event = {
  eventId: "11111111-1111-4111-8111-111111111111",
  eventType: "environment.deletion-requested.v1" as const,
  occurredAt: "2026-09-17T12:00:00.000Z",
  environmentId: "22222222-2222-4222-8222-222222222222",
  sourceTimestamp: "2026-09-17T11:59:00.000Z",
  reason: "pull_request_closed" as const,
};

function record(
  overrides: Partial<EnvironmentDeletionConsumerRecord> = {},
): EnvironmentDeletionConsumerRecord {
  return {
    topic: "previewforge.environment-commands.v1",
    partition: 1,
    offset: "7",
    key: Buffer.from(event.environmentId),
    value: Buffer.from(JSON.stringify(event)),
    headers: { "event-id": event.eventId, "event-type": event.eventType },
    ...overrides,
  };
}

class FakeDeliveryRepository {
  claim: FeedbackDeliveryClaim = { kind: "CLAIMED", attempts: 1 };
  readonly processed: unknown[] = [];
  readonly retries: unknown[] = [];
  readonly deadLetters: unknown[] = [];

  async claimDelivery(): Promise<FeedbackDeliveryClaim> {
    return this.claim;
  }

  async markDeliveryProcessed(input: unknown): Promise<void> {
    this.processed.push(input);
  }

  async scheduleRetry(): Promise<FeedbackDeliveryOutcome> {
    this.retries.push(true);
    return {
      outcome: "RETRY_SCHEDULED",
      attempts: 1,
      availableAt: new Date(),
      deadLetteredAt: null,
    };
  }

  async recordDeadLetter(): Promise<FeedbackDeliveryOutcome> {
    this.deadLetters.push(true);
    return {
      outcome: "DEAD_LETTER",
      attempts: 1,
      availableAt: new Date(),
      deadLetteredAt: new Date(),
    };
  }
}

class FakeDeletionRepository {
  result: {
    kind: "COMPLETED" | "CANCELLED" | "SKIPPED" | "FAILED";
    requestId?: string;
    reason?: string;
    code?: string;
    retryable?: boolean;
    message?: string;
  } = { kind: "COMPLETED", requestId: "33333333-3333-4333-8333-333333333333" };
  calls = 0;

  async process(): Promise<unknown> {
    this.calls += 1;
    return this.result;
  }
}

class FakeOffsets {
  readonly commits: Array<{ topic: string; partition: number; offset: string }> = [];

  async commitOffset(input: { topic: string; partition: number; offset: string }): Promise<void> {
    this.commits.push(input);
  }
}

function options(
  repository: FakeDeletionRepository,
  deliveryRepository: FakeDeliveryRepository,
  offsets: FakeOffsets,
) {
  return {
    repository: repository as unknown as Pick<EnvironmentDeletionRepository, "process">,
    deliveryRepository: deliveryRepository as unknown as Pick<
      DeploymentFeedbackRepository,
      "claimDelivery" | "markDeliveryProcessed" | "scheduleRetry" | "recordDeadLetter"
    >,
    deleteNamespace: async () => undefined,
    consumerName: "worker:environment-cleanup",
    offsets,
  };
}

describe("handleEnvironmentDeletionMessage", () => {
  it("settles the deletion request before committing the Kafka offset", async () => {
    const repository = new FakeDeletionRepository();
    const deliveryRepository = new FakeDeliveryRepository();
    const offsets = new FakeOffsets();

    await expect(
      handleEnvironmentDeletionMessage(record(), options(repository, deliveryRepository, offsets)),
    ).resolves.toEqual({ kind: "PROCESSED", committed: true });
    expect(repository.calls).toBe(1);
    expect(deliveryRepository.processed).toHaveLength(1);
    expect(offsets.commits).toEqual([{ topic: record().topic, partition: 1, offset: "8" }]);
  });

  it("does not call the deletion repository for a duplicate durable delivery", async () => {
    const repository = new FakeDeletionRepository();
    const deliveryRepository = new FakeDeliveryRepository();
    deliveryRepository.claim = { kind: "PROCESSED", attempts: 2 };
    const offsets = new FakeOffsets();

    await expect(
      handleEnvironmentDeletionMessage(record(), options(repository, deliveryRepository, offsets)),
    ).resolves.toEqual({ kind: "ALREADY_PROCESSED", committed: true });
    expect(repository.calls).toBe(0);
  });

  it("keeps retryable deletion failures uncommitted", async () => {
    const repository = new FakeDeletionRepository();
    repository.result = {
      kind: "FAILED",
      requestId: "33333333-3333-4333-8333-333333333333",
      code: "KUBERNETES_API_TIMEOUT",
      retryable: true,
      message: "Kubernetes API timed out during preview namespace deletion",
    };
    const deliveryRepository = new FakeDeliveryRepository();
    const offsets = new FakeOffsets();

    await expect(
      handleEnvironmentDeletionMessage(record(), options(repository, deliveryRepository, offsets)),
    ).resolves.toMatchObject({ kind: "RETRY_SCHEDULED", committed: false });
    expect(deliveryRepository.retries).toHaveLength(1);
    expect(offsets.commits).toHaveLength(0);
  });

  it("dead-letters ownership conflicts and malformed events without raw payloads", async () => {
    const repository = new FakeDeletionRepository();
    repository.result = {
      kind: "FAILED",
      requestId: "33333333-3333-4333-8333-333333333333",
      code: "PREVIEW_OWNERSHIP_CONFLICT",
      retryable: false,
      message: "Preview namespace ownership conflict",
    };
    const deliveryRepository = new FakeDeliveryRepository();
    const offsets = new FakeOffsets();
    const deletionOptions = options(repository, deliveryRepository, offsets);

    await expect(
      handleEnvironmentDeletionMessage(record(), deletionOptions),
    ).resolves.toMatchObject({
      kind: "DEAD_LETTERED",
      committed: true,
    });
    await expect(
      handleEnvironmentDeletionMessage(
        record({ value: Buffer.from('{"token":"raw-secret"') }),
        deletionOptions,
      ),
    ).resolves.toMatchObject({ kind: "DEAD_LETTERED", committed: true });
    expect(deliveryRepository.deadLetters).toHaveLength(2);
    expect(JSON.stringify(deliveryRepository.deadLetters)).not.toContain("raw-secret");
  });
});
