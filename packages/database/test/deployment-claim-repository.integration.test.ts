import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DeploymentClaimConflictError,
  DeploymentClaimRepository,
  DeploymentClaimValidationError,
  KafkaDeliveryIdentityConflictError,
  LeaseFenceError,
} from "../src/deployment-claim-repository.js";
import { createPrismaClient, type PrismaClient } from "../src/prisma-client.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const TOPIC = "previewforge.deployment-requests.v1";
const CONSUMER = "deployment-claim-integration";

describe("DeploymentClaimRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let repository: DeploymentClaimRepository;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    repository = new DeploymentClaimRepository(prisma);
    await prisma.$connect();
    await prisma.kafkaDelivery.deleteMany({ where: { consumerName: CONSUMER } });
    await prisma.consumerReceipt.deleteMany({ where: { consumerName: CONSUMER } });
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await prisma.consumerReceipt.deleteMany({ where: { eventId: { in: fixture.eventIds } } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: fixture.deploymentId } });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    const offsets = fixtures.flatMap((fixture) => [
      BigInt(fixture.offset),
      BigInt(fixture.offset + 1),
      BigInt(fixture.offset + 2),
    ]);
    await prisma.kafkaDelivery.deleteMany({
      where: { consumerName: CONSUMER, topic: TOPIC, partition: 0, offset: { in: offsets } },
    });
    await prisma.$disconnect();
  });

  it("atomically claims a desired deployment, receipts the event, and emits one stage event", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const result = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-a",
      leaseTtlMs: 30_000,
    });

    expect(result).toMatchObject({
      kind: "CLAIMED",
      deploymentId: fixture.deploymentId,
      environmentId: fixture.environmentId,
      commitSha: fixture.commitSha,
      leaseGeneration: 1,
    });
    if (result.kind !== "CLAIMED") return;

    const [deployment, receipt, deliveryRow, events] = await Promise.all([
      prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
      prisma.consumerReceipt.findUnique({
        where: { consumerName_eventId: { consumerName: CONSUMER, eventId: fixture.eventId } },
      }),
      prisma.kafkaDelivery.findUnique({
        where: {
          consumerName_topic_partition_offset: {
            consumerName: CONSUMER,
            topic: TOPIC,
            partition: 0,
            offset: BigInt(fixture.offset),
          },
        },
      }),
      prisma.outboxEvent.findMany({ where: { aggregateId: fixture.deploymentId } }),
    ]);

    expect(deployment).toMatchObject({
      status: "CLONING",
      leaseToken: result.leaseToken,
      leaseOwner: "worker-a",
      leaseGeneration: 1,
      leaseExpiresAt: expect.any(Date),
    });
    expect(receipt).toMatchObject({ consumerName: CONSUMER, eventId: fixture.eventId });
    expect(deliveryRow).toMatchObject({ status: "PROCESSED", eventId: fixture.eventId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "deployment.stage-changed.v1",
      aggregateType: "deployment",
      aggregateId: fixture.deploymentId,
      payload: expect.objectContaining({
        eventId: expect.any(String),
        fromStatus: "QUEUED",
        toStatus: "CLONING",
      }),
    });
  });

  it("collapses twelve concurrent duplicate deliveries to one receipt and transition", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const input = {
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-b",
      leaseTtlMs: 30_000,
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () => repository.claimRequestedDeployment(input)),
    );

    expect(results.filter((item) => item.kind === "CLAIMED")).toHaveLength(1);
    expect(
      results.filter((item) => item.kind === "DUPLICATE_ACTIVE_LEASE").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.consumerReceipt.count({
        where: { consumerName: CONSUMER, eventId: fixture.eventId },
      }),
    ).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      1,
    );
    expect(
      await prisma.deployment.count({ where: { id: fixture.deploymentId, status: "CLONING" } }),
    ).toBe(1);
  });

  it("rolls back the lease, transition event, delivery, and receipt when receipt insertion faults", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    await expect(
      repository.claimRequestedDeployment({
        delivery: delivery(fixture),
        event: fixture.event,
        workerId: "worker-fault",
        leaseTtlMs: 30_000,
        faultInjector: () => {
          throw new Error("injected before receipt");
        },
      }),
    ).rejects.toThrow("injected before receipt");

    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "QUEUED",
      leaseToken: null,
      leaseOwner: null,
    });
    expect(await prisma.consumerReceipt.count({ where: { eventId: fixture.eventId } })).toBe(0);
    expect(await prisma.kafkaDelivery.count({ where: { eventId: fixture.eventId } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      0,
    );
  });

  it("supersedes a queued deployment whose desired SHA is stale", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: "b".repeat(40) },
    });

    const result = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-stale",
      leaseTtlMs: 30_000,
    });

    expect(result).toMatchObject({ kind: "SUPERSEDED", deploymentId: fixture.deploymentId });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "SUPERSEDED",
      leaseToken: null,
      leaseOwner: null,
    });
    expect(await prisma.consumerReceipt.count({ where: { eventId: fixture.eventId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      1,
    );
  });

  it("takes over an expired CLONING lease without replaying QUEUED->CLONING", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const claimed = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-old",
      leaseTtlMs: 40,
    });
    expect(claimed.kind).toBe("CLAIMED");
    if (claimed.kind !== "CLAIMED") return;
    await waitForLeaseExpiry(prisma, fixture.deploymentId);

    const takeover = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-new",
      leaseTtlMs: 500,
    });

    expect(takeover).toMatchObject({
      kind: "RECLAIMED",
      leaseGeneration: 2,
    });
    if (takeover.kind !== "RECLAIMED") return;
    expect(takeover.leaseToken).not.toBe(claimed.leaseToken);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      1,
    );
  });

  it("fences the old owner after takeover and requires current desired SHA for side effects", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const claimed = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-old",
      leaseTtlMs: 30,
    });
    if (claimed.kind !== "CLAIMED") throw new Error("expected initial claim");
    await waitForLeaseExpiry(prisma, fixture.deploymentId);
    const takeover = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-new",
      leaseTtlMs: 500,
    });
    if (takeover.kind !== "RECLAIMED") throw new Error("expected lease takeover");

    const oldLease = {
      deploymentId: fixture.deploymentId,
      leaseToken: claimed.leaseToken,
      leaseGeneration: claimed.leaseGeneration,
      expectedDesiredSha: fixture.commitSha,
    };
    await expect(repository.assertSideEffectAllowed(oldLease)).rejects.toBeInstanceOf(
      LeaseFenceError,
    );
    await expect(repository.renewLease(oldLease)).rejects.toBeInstanceOf(LeaseFenceError);
    await expect(repository.releaseLease(oldLease)).rejects.toBeInstanceOf(LeaseFenceError);
    await expect(
      repository.assertSideEffectAllowed({
        deploymentId: fixture.deploymentId,
        leaseToken: takeover.leaseToken,
        leaseGeneration: takeover.leaseGeneration,
        expectedDesiredSha: fixture.commitSha,
      }),
    ).resolves.toMatchObject({ id: fixture.deploymentId });
  });

  it("supersedes a claimed deployment when desired SHA changes before side effects", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const claimed = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-stale-lease",
      leaseTtlMs: 30_000,
    });
    if (claimed.kind !== "CLAIMED") throw new Error("expected claim");
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: "c".repeat(40) },
    });

    await expect(
      repository.assertSideEffectAllowed({
        deploymentId: fixture.deploymentId,
        leaseToken: claimed.leaseToken,
        leaseGeneration: claimed.leaseGeneration,
        expectedDesiredSha: fixture.commitSha,
      }),
    ).rejects.toBeInstanceOf(LeaseFenceError);
    await expect(
      repository.supersedeStaleLease({
        deploymentId: fixture.deploymentId,
        leaseToken: claimed.leaseToken,
        leaseGeneration: claimed.leaseGeneration,
        expectedDesiredSha: fixture.commitSha,
      }),
    ).resolves.toBe(true);
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "SUPERSEDED",
      leaseToken: null,
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      2,
    );
  });

  it("never rewinds a terminal deployment and records one semantic receipt", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await prisma.deployment.update({
      where: { id: fixture.deploymentId },
      data: { status: "FAILED", finishedAt: new Date() },
    });

    const result = await repository.claimRequestedDeployment({
      delivery: delivery(fixture),
      event: fixture.event,
      workerId: "worker-terminal",
      leaseTtlMs: 30_000,
    });

    expect(result.kind).toBe("DUPLICATE_TERMINAL");
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "FAILED",
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      0,
    );
  });

  it("persists retry/dead-letter metadata without raw payload and redacts errors", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const metadata = {
      ...delivery(fixture),
      offset: fixture.offset + 1,
      eventId: undefined,
      eventType: undefined,
      environmentId: undefined,
      aggregateId: undefined,
    };
    const secret = "ghp_should-not-persist";
    await repository.scheduleRetry({
      delivery: metadata,
      errorCode: "BROKER_TIMEOUT",
      message: `temporary failure ${secret}`,
      retryDelayMs: 1_000,
    });
    await repository.recordDeadLetter({
      delivery: metadata,
      errorCode: "INVALID_EVENT",
      message: `permanent failure ${secret}`,
    });

    const stored = await prisma.kafkaDelivery.findUnique({
      where: {
        consumerName_topic_partition_offset: {
          consumerName: CONSUMER,
          topic: TOPIC,
          partition: 0,
          offset: BigInt(fixture.offset + 1),
        },
      },
    });
    expect(stored).toMatchObject({
      status: "DEAD_LETTER",
      attempts: 2,
      errorCode: "INVALID_EVENT",
    });
    expect(stored?.errorMessage).toContain("[REDACTED]");
    expect(stored?.errorMessage).not.toContain(secret);
    expect(
      JSON.stringify(stored, (_, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain(secret);
  });

  it("rejects a delivery offset reused with a different digest", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const metadata = delivery(fixture);
    await repository.recordDeadLetter({
      delivery: metadata,
      errorCode: "INVALID_EVENT",
      message: "first outcome",
    });
    await expect(
      repository.recordDeadLetter({
        delivery: { ...metadata, payloadDigest: "f".repeat(64) },
        errorCode: "INVALID_EVENT",
        message: "conflicting outcome",
      }),
    ).rejects.toBeInstanceOf(KafkaDeliveryIdentityConflictError);
  });

  it.each(["projectId", "repositoryFullName", "installationId"])(
    "rejects a deployment request with a mismatched %s and rolls back all delivery state",
    async (field) => {
      const fixture = await createFixture(prisma);
      fixtures.push(fixture);
      const event = { ...fixture.event };
      event[field] =
        field === "projectId"
          ? randomUUID()
          : field === "repositoryFullName"
            ? "other/repository"
            : "999999999999";
      await expect(
        repository.claimRequestedDeployment({
          delivery: delivery(fixture),
          event,
          workerId: "worker-identity",
          leaseTtlMs: 30_000,
        }),
      ).rejects.toBeInstanceOf(DeploymentClaimConflictError);
      await expectCleanQueued(prisma, fixture);
    },
  );

  it("requires every Kafka delivery identity header for a claim", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await expect(
      repository.claimRequestedDeployment({
        delivery: { ...delivery(fixture), eventType: undefined },
        event: fixture.event,
        workerId: "worker-missing",
        leaseTtlMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimValidationError);
    await expectQueuedNoMutation(prisma, fixture);
  });

  it("does not claim a dead-lettered or not-yet-due delivery", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const retryDelivery = { ...delivery(fixture), offset: fixture.offset + 1 };
    await repository.recordDeadLetter({
      delivery: retryDelivery,
      errorCode: "INVALID_EVENT",
      message: "permanent",
    });
    await expect(
      repository.claimRequestedDeployment({
        delivery: retryDelivery,
        event: fixture.event,
        workerId: "worker-dead",
        leaseTtlMs: 30_000,
      }),
    ).rejects.toMatchObject({
      name: "KafkaDeliveryNotClaimableError",
      code: "DELIVERY_DEAD_LETTER",
    });
    await expectQueuedNoMutation(prisma, fixture);

    const scheduled = { ...delivery(fixture), offset: fixture.offset + 2 };
    await repository.scheduleRetry({
      delivery: scheduled,
      errorCode: "BROKER_TIMEOUT",
      message: "temporary",
      retryDelayMs: 500,
    });
    await expect(
      repository.claimRequestedDeployment({
        delivery: scheduled,
        event: fixture.event,
        workerId: "worker-early",
        leaseTtlMs: 30_000,
      }),
    ).rejects.toMatchObject({
      name: "KafkaDeliveryNotClaimableError",
      code: "DELIVERY_RETRY_NOT_DUE",
    });
    await expectQueuedNoMutation(prisma, fixture);
  });

  it("processes a due retry atomically", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const scheduled = { ...delivery(fixture), offset: fixture.offset + 1 };
    await repository.scheduleRetry({
      delivery: scheduled,
      errorCode: "BROKER_TIMEOUT",
      message: "temporary",
      retryDelayMs: 0,
    });
    const result = await repository.claimRequestedDeployment({
      delivery: scheduled,
      event: fixture.event,
      workerId: "worker-retry",
      leaseTtlMs: 30_000,
    });
    expect(result.kind).toBe("CLAIMED");
    expect(
      await prisma.kafkaDelivery.findUnique({
        where: {
          consumerName_topic_partition_offset: {
            consumerName: CONSUMER,
            topic: TOPIC,
            partition: 0,
            offset: BigInt(scheduled.offset),
          },
        },
      }),
    ).toMatchObject({ status: "PROCESSED", attempts: 2 });
  });

  it("fails closed when a queued deployment already has a semantic receipt", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await prisma.consumerReceipt.create({
      data: { consumerName: CONSUMER, eventId: fixture.eventId },
    });
    await expect(
      repository.claimRequestedDeployment({
        delivery: delivery(fixture),
        event: fixture.event,
        workerId: "worker-invariant",
        leaseTtlMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimConflictError);
    await expectCleanQueued(prisma, fixture);
    expect(
      await prisma.consumerReceipt.count({
        where: { consumerName: CONSUMER, eventId: fixture.eventId },
      }),
    ).toBe(1);
  });

  it("fails closed for a processed delivery without its semantic receipt", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const processed = delivery(fixture);
    await prisma.kafkaDelivery.create({
      data: {
        ...processed,
        id: randomUUID(),
        offset: BigInt(processed.offset),
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    await expect(
      repository.claimRequestedDeployment({
        delivery: processed,
        event: fixture.event,
        workerId: "worker-invariant",
        leaseTtlMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimConflictError);
    await expectQueuedNoMutation(prisma, fixture);
    expect(
      await prisma.kafkaDelivery.count({
        where: { consumerName: CONSUMER, eventId: fixture.eventId, status: "PROCESSED" },
      }),
    ).toBe(1);
  });

  it("rejects unsafe durations, one-character error codes, and control characters", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await expect(
      repository.claimRequestedDeployment({
        delivery: delivery(fixture),
        event: fixture.event,
        workerId: "worker-bounds",
        leaseTtlMs: 24 * 60 * 60 * 1_000 + 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimValidationError);
    await expect(
      repository.claimRequestedDeployment({
        delivery: delivery(fixture),
        event: fixture.event,
        workerId: "worker-bounds",
        leaseTtlMs: Number.NaN,
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimValidationError);
    expect(() =>
      repository.scheduleRetry({
        delivery: { ...delivery(fixture), offset: fixture.offset + 1 },
        errorCode: "BROKER_TIMEOUT",
        message: "temporary",
        retryDelayMs: 24 * 60 * 60 * 1_000 + 1,
      }),
    ).toThrow(DeploymentClaimValidationError);
    await expect(
      repository.recordDeadLetter({
        delivery: { ...delivery(fixture), offset: fixture.offset + 2 },
        errorCode: "X",
        message: "permanent",
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimValidationError);
    await expect(
      repository.recordDeadLetter({
        delivery: { ...delivery(fixture), offset: fixture.offset + 3 },
        errorCode: "INVALID_EVENT",
        message: "bad\nsecret",
      }),
    ).rejects.toBeInstanceOf(DeploymentClaimValidationError);
  });
});

type Fixture = {
  userId: string;
  environmentId: string;
  deploymentId: string;
  eventId: string;
  offset: number;
  commitSha: string;
  githubInstallationId: string;
  eventIds: string[];
  event: Record<string, unknown>;
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const eventId = randomUUID();
  const githubInstallationId = String(Date.now()) + String(Math.floor(Math.random() * 1_000));
  const commitSha = suffix.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
  const offset = Math.floor(Math.random() * 1_000_000_000);
  await prisma.user.create({
    data: { id: userId, githubUserId: `claim-${suffix}`, githubLogin: `claim-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(githubInstallationId),
      accountLogin: `claim-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `claim/${suffix}`,
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      previewKey: `claim-${suffix}`,
      desiredCommitSha: commitSha,
    },
  });
  await prisma.deployment.create({ data: { id: deploymentId, environmentId, commitSha } });
  return {
    userId,
    environmentId,
    deploymentId,
    eventId,
    offset,
    commitSha,
    githubInstallationId,
    eventIds: [eventId],
    event: {
      eventId,
      eventType: "deployment.requested.v1",
      occurredAt: new Date().toISOString(),
      deploymentId,
      environmentId,
      projectId,
      installationId: githubInstallationId,
      repositoryFullName: `claim/${suffix}`,
      pullRequestNumber: 1,
      commitSha,
    },
  };
}

function delivery(fixture: Fixture): {
  consumerName: string;
  topic: string;
  partition: number;
  offset: number;
  payloadDigest: string;
  eventId: string;
  eventType: string;
  environmentId: string;
  aggregateId: string;
} {
  return {
    consumerName: CONSUMER,
    topic: TOPIC,
    partition: 0,
    offset: fixture.offset,
    payloadDigest: "a".repeat(64),
    eventId: fixture.eventId,
    eventType: "deployment.requested.v1",
    environmentId: fixture.environmentId,
    aggregateId: fixture.deploymentId,
  };
}

async function waitForLeaseExpiry(prisma: PrismaClient, deploymentId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { leaseExpiresAt: true },
    });
    const server = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    if (row?.leaseExpiresAt && server[0] && server[0].now >= row.leaseExpiresAt) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("lease did not expire within bounded test window");
}

async function expectCleanQueued(prisma: PrismaClient, fixture: Fixture): Promise<void> {
  expect(await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } })).toMatchObject(
    { status: "QUEUED", leaseToken: null },
  );
  expect(
    await prisma.kafkaDelivery.count({
      where: { consumerName: CONSUMER, eventId: fixture.eventId },
    }),
  ).toBe(0);
  expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(0);
}

async function expectQueuedNoMutation(prisma: PrismaClient, fixture: Fixture): Promise<void> {
  expect(await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } })).toMatchObject(
    { status: "QUEUED", leaseToken: null },
  );
  expect(
    await prisma.consumerReceipt.count({
      where: { consumerName: CONSUMER, eventId: fixture.eventId },
    }),
  ).toBe(0);
  expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(0);
}
