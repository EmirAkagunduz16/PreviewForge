import type {
  DeploymentFeedbackRepository,
  FeedbackDeliveryClaim,
  FeedbackDeliveryOutcome,
} from "@previewforge/database";
import { describe, expect, it } from "vitest";
import {
  type DeploymentFeedbackConsumerRecord,
  handleDeploymentFeedbackMessage,
} from "./consumer.js";
import type { DeploymentFeedbackEvent, GitHubCheckRunCoordinator } from "./coordinator.js";

const event: DeploymentFeedbackEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  eventType: "deployment.ready.v1",
  occurredAt: "2026-09-17T12:00:00.000Z",
  deploymentId: "33333333-3333-4333-8333-333333333333",
  environmentId: "22222222-2222-4222-8222-222222222222",
  commitSha: "a".repeat(40),
  fromStatus: "WAITING_FOR_HEALTHCHECK",
  toStatus: "READY",
};

function record(
  overrides: Partial<DeploymentFeedbackConsumerRecord> = {},
): DeploymentFeedbackConsumerRecord {
  return {
    topic: "previewforge.deployment-events.v1",
    partition: 1,
    offset: "7",
    key: Buffer.from(event.environmentId),
    value: Buffer.from(JSON.stringify(event)),
    headers: { "event-id": event.eventId, "event-type": event.eventType },
    ...overrides,
  };
}

class FakeRepository {
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

class FakeCoordinator {
  calls = 0;
  failure: unknown;

  async process(_event: DeploymentFeedbackEvent): Promise<"PROCESSED"> {
    this.calls += 1;
    if (this.failure !== undefined) throw this.failure;
    return "PROCESSED";
  }
}

class FakeOffsets {
  readonly commits: Array<{ topic: string; partition: number; offset: string }> = [];
  async commitOffset(input: { topic: string; partition: number; offset: string }): Promise<void> {
    this.commits.push(input);
  }
}

function options(repository: FakeRepository, coordinator: FakeCoordinator, offsets: FakeOffsets) {
  return {
    repository: repository as unknown as Pick<
      DeploymentFeedbackRepository,
      "claimDelivery" | "markDeliveryProcessed" | "scheduleRetry" | "recordDeadLetter"
    >,
    coordinator: coordinator as unknown as Pick<GitHubCheckRunCoordinator, "process">,
    consumerName: "worker:github-checks",
    offsets,
  };
}

describe("handleDeploymentFeedbackMessage", () => {
  it("marks a successful side effect durable before committing the Kafka offset", async () => {
    const repository = new FakeRepository();
    const coordinator = new FakeCoordinator();
    const offsets = new FakeOffsets();

    await expect(
      handleDeploymentFeedbackMessage(record(), options(repository, coordinator, offsets)),
    ).resolves.toEqual({
      kind: "PROCESSED",
      committed: true,
    });
    expect(coordinator.calls).toBe(1);
    expect(repository.processed).toHaveLength(1);
    expect(offsets.commits).toEqual([{ topic: record().topic, partition: 1, offset: "8" }]);
  });

  it("does not call GitHub again for a duplicate durable Kafka delivery", async () => {
    const repository = new FakeRepository();
    repository.claim = { kind: "PROCESSED", attempts: 2 };
    const coordinator = new FakeCoordinator();
    const offsets = new FakeOffsets();

    await expect(
      handleDeploymentFeedbackMessage(record(), options(repository, coordinator, offsets)),
    ).resolves.toEqual({
      kind: "ALREADY_PROCESSED",
      committed: true,
    });
    expect(coordinator.calls).toBe(0);
  });

  it("leaves transient GitHub failures uncommitted and schedules a durable retry", async () => {
    const repository = new FakeRepository();
    const coordinator = new FakeCoordinator();
    coordinator.failure = { code: "CHECKS_RATE_LIMITED", retryable: true };
    const offsets = new FakeOffsets();

    await expect(
      handleDeploymentFeedbackMessage(record(), options(repository, coordinator, offsets)),
    ).resolves.toMatchObject({
      kind: "RETRY_SCHEDULED",
      committed: false,
    });
    expect(repository.retries).toHaveLength(1);
    expect(offsets.commits).toHaveLength(0);
  });

  it("dead-letters permanent failures and malformed records without copying raw payloads", async () => {
    const repository = new FakeRepository();
    const coordinator = new FakeCoordinator();
    coordinator.failure = { code: "CHECKS_FORBIDDEN", retryable: false };
    const offsets = new FakeOffsets();

    await expect(
      handleDeploymentFeedbackMessage(record(), options(repository, coordinator, offsets)),
    ).resolves.toMatchObject({ kind: "DEAD_LETTERED", committed: true });
    await expect(
      handleDeploymentFeedbackMessage(
        record({ value: Buffer.from('{"token":"raw-secret"') }),
        options(repository, coordinator, offsets),
      ),
    ).resolves.toMatchObject({ kind: "DEAD_LETTERED", committed: true });
    expect(repository.deadLetters).toHaveLength(2);
    expect(JSON.stringify(repository.deadLetters)).not.toContain("raw-secret");
  });
});
