import type { DeploymentClaimResult } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import type {
  DeploymentClaimRepository,
  DeploymentConsumerRecord,
  DeploymentOffsetCommitter,
} from "./deployment-consumer.js";
import { handleDeploymentMessage } from "./deployment-consumer.js";

type KafkaDeliveryOutcomeResult = Awaited<ReturnType<DeploymentClaimRepository["scheduleRetry"]>>;

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

function record(overrides: Partial<DeploymentConsumerRecord> = {}): DeploymentConsumerRecord {
  return {
    topic: "previewforge.deployment-requests.v1",
    partition: 2,
    offset: "7",
    key: Buffer.from(requestedEvent.environmentId),
    value: Buffer.from(JSON.stringify(requestedEvent)),
    headers: {
      "event-id": requestedEvent.eventId,
      "event-type": requestedEvent.eventType,
    },
    ...overrides,
  };
}

class FakeRepository implements DeploymentClaimRepository {
  claimCalls = 0;
  claimResult: DeploymentClaimResult = {
    kind: "CLAIMED",
    deploymentId: ids.deployment,
    environmentId: ids.environment,
    commitSha: requestedEvent.commitSha,
    leaseToken: "019930c0-c522-7474-a3f0-1ee461901c24",
    leaseGeneration: 1,
  };
  claimError: unknown;
  claimPromise?: Promise<DeploymentClaimResult>;
  readonly deadLetters: Array<Parameters<DeploymentClaimRepository["recordDeadLetter"]>[0]> = [];
  readonly retries: Array<Parameters<DeploymentClaimRepository["scheduleRetry"]>[0]> = [];
  deadLetterError: unknown;
  retryError: unknown;
  deadLetterResult: KafkaDeliveryOutcomeResult = {
    outcome: "DEAD_LETTER",
    attempts: 1,
    availableAt: new Date(0),
    deadLetteredAt: new Date(0),
  };
  retryResult: KafkaDeliveryOutcomeResult = {
    outcome: "RETRY_SCHEDULED",
    attempts: 1,
    availableAt: new Date(0),
    deadLetteredAt: null,
  };

  async claimRequestedDeployment(
    _input: Parameters<DeploymentClaimRepository["claimRequestedDeployment"]>[0],
  ): Promise<DeploymentClaimResult> {
    this.claimCalls += 1;
    if (this.claimError !== undefined) throw this.claimError;
    if (this.claimPromise !== undefined) return this.claimPromise;
    return this.claimResult;
  }

  async recordDeadLetter(
    input: Parameters<DeploymentClaimRepository["recordDeadLetter"]>[0],
  ): Promise<KafkaDeliveryOutcomeResult> {
    if (this.deadLetterError !== undefined) throw this.deadLetterError;
    this.deadLetters.push(input);
    return this.deadLetterResult;
  }

  async scheduleRetry(
    input: Parameters<DeploymentClaimRepository["scheduleRetry"]>[0],
  ): Promise<KafkaDeliveryOutcomeResult> {
    if (this.retryError !== undefined) throw this.retryError;
    this.retries.push(input);
    return this.retryResult;
  }
}

class FakeOffsets implements DeploymentOffsetCommitter {
  readonly commits: Array<{ topic: string; partition: number; offset: string }> = [];
  commitError: unknown;

  async commitOffset(input: { topic: string; partition: number; offset: string }): Promise<void> {
    if (this.commitError !== undefined) throw this.commitError;
    this.commits.push(input);
  }
}

function options(repository: FakeRepository, offsets: FakeOffsets) {
  return {
    repository,
    offsets,
    consumerName: "deployment-consumer-test",
    workerId: "worker-test",
    leaseTtlMs: 30_000,
    maxAttempts: 7,
    retryBaseDelayMs: 123,
    retryMaxDelayMs: 2_000,
  };
}

describe("handleDeploymentMessage", () => {
  it("does not commit while the durable claim is unresolved", async () => {
    const repository = new FakeRepository();
    const offsets = new FakeOffsets();
    let resolveClaim!: (value: DeploymentClaimResult) => void;
    repository.claimPromise = new Promise<DeploymentClaimResult>((resolve) => {
      resolveClaim = resolve;
    });

    const handling = handleDeploymentMessage(record(), options(repository, offsets));
    await vi.waitFor(() => expect(repository.claimCalls).toBe(1));
    expect(offsets.commits).toHaveLength(0);

    resolveClaim(repository.claimResult);
    await expect(handling).resolves.toEqual({ kind: "PROCESSED", committed: true });
    expect(offsets.commits).toEqual([
      { topic: "previewforge.deployment-requests.v1", partition: 2, offset: "8" },
    ]);
  });

  it("leaves the offset uncommitted when the crash hook fires after DB commit", async () => {
    const repository = new FakeRepository();
    const offsets = new FakeOffsets();
    let crash = true;
    const consumerOptions = {
      ...options(repository, offsets),
      afterDatabaseCommitBeforeOffsetCommit: async () => {
        if (crash) {
          crash = false;
          throw new Error("test crash");
        }
      },
    };

    await expect(handleDeploymentMessage(record(), consumerOptions)).resolves.toEqual({
      kind: "FAILED",
      committed: false,
      code: "OFFSET_COMMIT_DEFERRED",
    });
    expect(repository.claimCalls).toBe(1);
    expect(offsets.commits).toHaveLength(0);

    repository.claimResult = {
      kind: "DUPLICATE_ACTIVE_LEASE",
      deploymentId: ids.deployment,
      environmentId: ids.environment,
      leaseGeneration: 1,
    };
    await expect(handleDeploymentMessage(record(), consumerOptions)).resolves.toEqual({
      kind: "ALREADY_PROCESSED",
      committed: true,
    });
    expect(repository.claimCalls).toBe(2);
    expect(offsets.commits).toHaveLength(1);
  });

  it.each([
    ["invalid JSON", { value: Buffer.from('{"token":"raw-secret"') }, "INVALID_JSON"],
    [
      "invalid header",
      { headers: { "event-id": "not-a-uuid", "event-type": requestedEvent.eventType } },
      "INVALID_KAFKA_RECORD",
    ],
    ["invalid key", { key: Buffer.from("wrong-environment") }, "KEY_IDENTITY_MISMATCH"],
  ] as const)(
    "dead-letters %s and commits only after durable write",
    async (_label, overrides, code) => {
      const repository = new FakeRepository();
      const offsets = new FakeOffsets();

      const result = await handleDeploymentMessage(record(overrides), options(repository, offsets));

      expect(result).toEqual({ kind: "DEAD_LETTERED", committed: true });
      expect(repository.claimCalls).toBe(0);
      expect(repository.deadLetters).toHaveLength(1);
      expect(repository.deadLetters[0]?.errorCode).toBe(code);
      if (_label === "invalid header") {
        expect(repository.deadLetters[0]?.delivery.eventId).toBeUndefined();
      }
      expect(offsets.commits).toEqual([
        { topic: "previewforge.deployment-requests.v1", partition: 2, offset: "8" },
      ]);
      expect(JSON.stringify(repository.deadLetters)).not.toContain("raw-secret");
    },
  );

  it("preserves a valid v7 event ID when an otherwise invalid key is dead-lettered", async () => {
    const repository = new FakeRepository();
    const offsets = new FakeOffsets();

    await expect(
      handleDeploymentMessage(
        record({ key: Buffer.from("wrong-environment") }),
        options(repository, offsets),
      ),
    ).resolves.toEqual({ kind: "DEAD_LETTERED", committed: true });

    expect(repository.deadLetters[0]?.delivery.eventId).toBe(requestedEvent.eventId);
    expect(repository.deadLetters[0]?.event?.eventId).toBe(requestedEvent.eventId);
  });

  it("does not commit when the dead-letter write fails", async () => {
    const repository = new FakeRepository();
    repository.deadLetterError = new Error("database secret should not escape");
    const offsets = new FakeOffsets();

    await expect(
      handleDeploymentMessage(
        record({ value: Buffer.from("{invalid-json") }),
        options(repository, offsets),
      ),
    ).resolves.toEqual({
      kind: "FAILED",
      committed: false,
      code: "DEAD_LETTER_PERSISTENCE_FAILED",
    });
    expect(offsets.commits).toHaveLength(0);
  });

  it("schedules a transient retry durably without committing the offset", async () => {
    const repository = new FakeRepository();
    repository.claimError = { code: "40001" };
    const offsets = new FakeOffsets();

    const result = await handleDeploymentMessage(record(), options(repository, offsets));

    expect(result).toEqual({
      kind: "RETRY_SCHEDULED",
      committed: false,
      code: "DEPLOYMENT_CLAIM_RETRYABLE",
    });
    expect(repository.retries[0]?.errorCode).toBe("DEPLOYMENT_CLAIM_RETRYABLE");
    expect(repository.retries[0]?.errorCode).not.toBe("40001");
    expect(repository.retries).toHaveLength(1);
    expect(repository.retries[0]).toMatchObject({
      maxAttempts: 7,
      retryBaseDelayMs: 123,
      retryMaxDelayMs: 2_000,
    });
    expect(offsets.commits).toHaveLength(0);
  });

  it("dead-letters an aggregate permanent failure and then commits", async () => {
    const repository = new FakeRepository();
    repository.claimError = { code: "DEPLOYMENT_AGGREGATE_MISMATCH" };
    const offsets = new FakeOffsets();

    await expect(handleDeploymentMessage(record(), options(repository, offsets))).resolves.toEqual({
      kind: "DEAD_LETTERED",
      committed: true,
    });
    expect(repository.deadLetters[0]?.errorCode).toBe("DEPLOYMENT_AGGREGATE_MISMATCH");
    expect(repository.retries).toHaveLength(0);
    expect(offsets.commits).toHaveLength(1);
  });

  it.each(["DEPLOYMENT_CLAIM_RACE", "P2034"] as const)(
    "schedules %s durably without committing",
    async (code) => {
      const repository = new FakeRepository();
      repository.claimError = { code };
      const offsets = new FakeOffsets();

      await expect(
        handleDeploymentMessage(record(), options(repository, offsets)),
      ).resolves.toEqual({
        kind: "RETRY_SCHEDULED",
        committed: false,
        code: "DEPLOYMENT_CLAIM_RETRYABLE",
      });
      expect(repository.retries[0]?.errorCode).toBe("DEPLOYMENT_CLAIM_RETRYABLE");
      expect(repository.retries[0]?.errorCode).not.toBe(code);
      expect(offsets.commits).toHaveLength(0);
    },
  );

  it("commits after durable retry exhaustion dead-letters the delivery", async () => {
    const repository = new FakeRepository();
    repository.claimError = { code: "DEPLOYMENT_CLAIM_RACE" };
    repository.retryResult = {
      outcome: "DEAD_LETTER",
      attempts: 7,
      availableAt: new Date(0),
      deadLetteredAt: new Date(0),
    };
    const offsets = new FakeOffsets();

    await expect(handleDeploymentMessage(record(), options(repository, offsets))).resolves.toEqual({
      kind: "DEAD_LETTERED",
      committed: true,
    });
    expect(repository.deadLetters).toHaveLength(0);
    expect(repository.retries[0]?.maxAttempts).toBe(7);
    expect(offsets.commits).toHaveLength(1);
  });

  it.each([
    ["CLAIMED", "PROCESSED"],
    ["RECLAIMED", "PROCESSED"],
    ["DUPLICATE_ACTIVE_LEASE", "ALREADY_PROCESSED"],
    ["DUPLICATE_TERMINAL", "ALREADY_PROCESSED"],
    ["SUPERSEDED", "SUPERSEDED"],
  ] as const)("maps concrete claim result %s exhaustively", async (kind, expectedKind) => {
    const repository = new FakeRepository();
    repository.claimResult =
      kind === "CLAIMED" || kind === "RECLAIMED"
        ? {
            kind,
            deploymentId: ids.deployment,
            environmentId: ids.environment,
            commitSha: requestedEvent.commitSha,
            leaseToken: "019930c0-c522-7474-a3f0-1ee461901c24",
            leaseGeneration: 1,
          }
        : kind === "SUPERSEDED"
          ? {
              kind,
              deploymentId: ids.deployment,
              environmentId: ids.environment,
              leaseGeneration: 1,
            }
          : {
              kind,
              deploymentId: ids.deployment,
              environmentId: ids.environment,
              leaseGeneration: 1,
            };
    const offsets = new FakeOffsets();

    await expect(handleDeploymentMessage(record(), options(repository, offsets))).resolves.toEqual({
      kind: expectedKind,
      committed: true,
    });
  });

  it("does not commit or reschedule a retry that is not due", async () => {
    const repository = new FakeRepository();
    repository.claimError = { code: "DELIVERY_RETRY_NOT_DUE" };
    const offsets = new FakeOffsets();

    const result = await handleDeploymentMessage(record(), options(repository, offsets));

    expect(result).toEqual({
      kind: "RETRY_DEFERRED",
      committed: false,
      code: "DELIVERY_RETRY_NOT_DUE",
    });
    expect(repository.retries).toHaveLength(0);
    expect(offsets.commits).toHaveLength(0);
  });

  it("commits a delivery that is already durably dead-lettered", async () => {
    const repository = new FakeRepository();
    repository.claimError = { code: "DELIVERY_DEAD_LETTER" };
    const offsets = new FakeOffsets();

    const result = await handleDeploymentMessage(record(), options(repository, offsets));

    expect(result).toEqual({ kind: "ALREADY_DEAD_LETTERED", committed: true });
    expect(repository.deadLetters).toHaveLength(0);
    expect(offsets.commits).toEqual([
      { topic: "previewforge.deployment-requests.v1", partition: 2, offset: "8" },
    ]);
  });

  it("increments offsets above Number.MAX_SAFE_INTEGER using BigInt", async () => {
    const repository = new FakeRepository();
    const offsets = new FakeOffsets();
    const sourceOffset = "900719925474099312345678901234";

    await expect(
      handleDeploymentMessage(record({ offset: sourceOffset }), options(repository, offsets)),
    ).resolves.toEqual({ kind: "PROCESSED", committed: true });
    expect(offsets.commits[0]?.offset).toBe((BigInt(sourceOffset) + 1n).toString());
  });

  it("fails closed on unknown claim errors without exposing their secret", async () => {
    const repository = new FakeRepository();
    repository.claimError = new Error("authorization: Bearer very-secret-token");
    const offsets = new FakeOffsets();

    const result = await handleDeploymentMessage(record(), options(repository, offsets));

    expect(result).toEqual({ kind: "FAILED", committed: false, code: "DEPLOYMENT_CLAIM_FAILED" });
    expect(repository.retries).toHaveLength(0);
    expect(offsets.commits).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("very-secret-token");
  });

  it.each(["retryBaseDelayMs", "retryMaxDelayMs"] as const)(
    "rejects a zero %s before touching the repository",
    async (option) => {
      const repository = new FakeRepository();
      const offsets = new FakeOffsets();
      const consumerOptions = { ...options(repository, offsets), [option]: 0 };

      await expect(handleDeploymentMessage(record(), consumerOptions)).rejects.toThrow(
        "Invalid deployment consumer",
      );
      expect(repository.claimCalls).toBe(0);
      expect(offsets.commits).toHaveLength(0);
    },
  );
});
