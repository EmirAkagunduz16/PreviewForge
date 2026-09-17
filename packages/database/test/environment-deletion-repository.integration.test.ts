import { randomUUID } from "node:crypto";
import {
  type EnvironmentDeletionRequested,
  environmentDeletionRequestedSchema,
} from "@previewforge/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  EnvironmentDeletionRepository,
  type PrismaClient,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

describe("EnvironmentDeletionRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { in: fixtures.map((fixture) => fixture.event.environmentId) } },
    });
    for (const fixture of fixtures) await prisma.user.delete({ where: { id: fixture.userId } });
    await prisma.$disconnect();
  });

  it("deletes one owned request and makes repeated delivery a durable no-op", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new EnvironmentDeletionRepository(prisma);
    let deletes = 0;

    await expect(
      repository.process({
        event: fixture.event,
        deleteNamespace: async () => {
          deletes += 1;
        },
      }),
    ).resolves.toEqual({ kind: "COMPLETED", requestId: fixture.requestId });
    await expect(
      repository.process({
        event: fixture.event,
        deleteNamespace: async () => {
          deletes += 1;
        },
      }),
    ).resolves.toEqual({
      kind: "SKIPPED",
      requestId: fixture.requestId,
      reason: "ALREADY_COMPLETED",
    });

    expect(deletes).toBe(1);
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: fixture.requestId } }),
    ).toMatchObject({ status: "COMPLETED", failureReason: null });
  });

  it("serializes concurrent workers so only one destructive callback runs", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new EnvironmentDeletionRepository(prisma);
    let deletes = 0;

    const results = await Promise.all(
      [1, 2].map(() =>
        repository.process({
          event: fixture.event,
          deleteNamespace: async () => {
            deletes += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
          },
        }),
      ),
    );

    expect(results.filter((result) => result.kind === "COMPLETED")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "SKIPPED")).toHaveLength(1);
    expect(deletes).toBe(1);
  });

  it("cancels a close request after a reopen and never calls Kubernetes", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await prisma.pullRequest.update({
      where: { id: fixture.pullRequestId },
      data: { state: "OPEN" },
    });
    const repository = new EnvironmentDeletionRepository(prisma);
    let deletes = 0;

    await expect(
      repository.process({
        event: fixture.event,
        deleteNamespace: async () => {
          deletes += 1;
        },
      }),
    ).resolves.toEqual({
      kind: "CANCELLED",
      requestId: fixture.requestId,
      reason: "ENVIRONMENT_REOPENED",
    });
    expect(deletes).toBe(0);
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: fixture.requestId } }),
    ).toMatchObject({ status: "CANCELLED" });
  });

  it("persists a retryable failure and can recover it on redelivery", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new EnvironmentDeletionRepository(prisma);

    await expect(
      repository.process({
        event: fixture.event,
        deleteNamespace: async () => {
          throw { code: "KUBERNETES_API_TIMEOUT", retryable: true, secret: "must-not-persist" };
        },
      }),
    ).resolves.toMatchObject({
      kind: "FAILED",
      code: "KUBERNETES_API_TIMEOUT",
      retryable: true,
    });
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: fixture.requestId } }),
    ).toMatchObject({
      status: "FAILED",
      failureReason: "Kubernetes API timed out during preview namespace deletion",
    });

    await expect(
      repository.process({ event: fixture.event, deleteNamespace: async () => undefined }),
    ).resolves.toEqual({ kind: "COMPLETED", requestId: fixture.requestId });
  });

  it("fails closed on an aggregate mismatch without invoking deletion", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new EnvironmentDeletionRepository(prisma);
    let deletes = 0;

    await expect(
      repository.process({
        event: { ...fixture.event, repositoryFullName: "other/repository" },
        deleteNamespace: async () => {
          deletes += 1;
        },
      }),
    ).resolves.toMatchObject({
      kind: "FAILED",
      code: "DELETION_AGGREGATE_MISMATCH",
      retryable: false,
    });
    expect(deletes).toBe(0);
  });

  it("enqueues one TTL intent, preserves the reason, and skips closed or repeated candidates", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const now = new Date("2026-09-17T12:00:00.000Z");
    const expiresAt = new Date("2026-09-17T11:00:00.000Z");
    await prisma.environmentDeletionRequest.delete({ where: { id: fixture.requestId } });
    await prisma.pullRequest.update({
      where: { id: fixture.pullRequestId },
      data: { state: "OPEN" },
    });
    await prisma.previewEnvironment.update({
      where: { id: fixture.event.environmentId },
      data: { status: "ACTIVE", expiresAt },
    });

    const repository = new EnvironmentDeletionRepository(prisma);
    await expect(repository.enqueueExpired({ now, limit: 10 })).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      skipped: 0,
    });
    await expect(repository.enqueueExpired({ now, limit: 10 })).resolves.toEqual({
      scanned: 1,
      enqueued: 0,
      skipped: 1,
    });

    const request = await prisma.environmentDeletionRequest.findUnique({
      where: { environmentId: fixture.event.environmentId },
      select: { status: true, reason: true, sourceUpdatedAt: true },
    });
    expect(request).toEqual({
      status: "REQUESTED",
      reason: "ttl_expired",
      sourceUpdatedAt: expiresAt,
    });
    const outbox = await prisma.outboxEvent.findFirst({
      where: {
        eventType: "environment.deletion-requested.v1",
        aggregateId: fixture.event.environmentId,
      },
    });
    expect(environmentDeletionRequestedSchema.parse(outbox?.payload)).toMatchObject({
      environmentId: fixture.event.environmentId,
      reason: "ttl_expired",
      sourceTimestamp: expiresAt.toISOString(),
    });

    const closedFixture = await createFixture(prisma);
    fixtures.push(closedFixture);
    await prisma.environmentDeletionRequest.delete({ where: { id: closedFixture.requestId } });
    await prisma.previewEnvironment.update({
      where: { id: closedFixture.event.environmentId },
      data: { status: "ACTIVE", expiresAt },
    });
    await expect(repository.enqueueExpired({ now, limit: 10 })).resolves.toEqual({
      scanned: 2,
      enqueued: 0,
      skipped: 2,
    });
  });
});

type Fixture = {
  userId: string;
  pullRequestId: string;
  requestId: string;
  event: EnvironmentDeletionRequested;
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const pullRequestId = randomUUID();
  const environmentId = randomUUID();
  const requestId = randomUUID();
  const repositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  const installationGithubId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  const sourceTimestamp = "2026-09-17T12:00:00.000Z";

  await prisma.user.create({
    data: { id: userId, githubUserId: `deletion-${suffix}`, githubLogin: `deletion-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(installationGithubId),
      accountLogin: `deletion-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      githubRepositoryId: BigInt(repositoryId),
      repositoryFullName: `deletion/${suffix}`,
    },
  });
  await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number: 1,
      headSha: "a".repeat(40),
      state: "CLOSED",
      sourceUpdatedAt: new Date(sourceTimestamp),
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      pullRequestId,
      previewKey: `deletion-${suffix}`,
      desiredCommitSha: "a".repeat(40),
      status: "ACTIVE",
    },
  });
  await prisma.environmentDeletionRequest.create({
    data: {
      id: requestId,
      environmentId,
      requestKey: `environment:${environmentId}`,
      status: "REQUESTED",
      sourceUpdatedAt: new Date(sourceTimestamp),
      sourceDeliveryId: `delivery-${suffix}`,
    },
  });

  return {
    userId,
    pullRequestId,
    requestId,
    event: {
      eventId: randomUUID(),
      eventType: "environment.deletion-requested.v1",
      occurredAt: sourceTimestamp,
      environmentId,
      sourceTimestamp,
      projectId,
      pullRequestId,
      pullRequestNumber: 1,
      repositoryId,
      repositoryFullName: `deletion/${suffix}`,
      installationId: installationGithubId,
      reason: "pull_request_closed",
    },
  };
}
