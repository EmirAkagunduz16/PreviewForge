import { createHash, randomUUID } from "node:crypto";
import {
  deploymentRequestedSchema,
  environmentDeletionRequestedSchema,
} from "@previewforge/contracts";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../src/prisma-client.js";
import {
  type PrismaClient,
  WebhookDeliveryConflictError,
  WebhookRepository,
} from "../src/webhook-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

describe("WebhookRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const fixture of fixtures) await cleanup(prisma, fixture);
    await prisma.$disconnect();
  });

  it("claims an opened delivery and atomically creates desired environment, deployment, and outbox", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const opened = event(fixture, "opened", "2026-09-13T10:00:00.000Z");

    const deliveryId = delivery(fixture, "open");
    const result = await new WebhookRepository(prisma).process(input(opened, deliveryId));

    expect(result).toMatchObject({ duplicate: false, stale: false, action: "opened" });
    expect(result.deploymentId).toBeDefined();
    const deploymentId = result.deploymentId;
    if (!deploymentId) throw new Error("opened webhook did not create a deployment");
    expect(await prisma.webhookDelivery.count({ where: { deliveryId } })).toBe(1);
    const pullRequest = await prisma.pullRequest.findUnique({
      where: { projectId_number: { projectId: fixture.projectId, number: fixture.number } },
      include: { environment: true },
    });
    expect(pullRequest?.state).toBe("OPEN");
    expect(pullRequest?.headSha).toBe(fixture.commitSha);
    expect(pullRequest?.environment?.desiredCommitSha).toBe(fixture.commitSha);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "deployment.requested.v1", aggregateId: deploymentId },
      }),
    ).toBe(1);
    const deploymentOutbox = await prisma.outboxEvent.findFirst({
      where: { aggregateId: deploymentId },
    });
    expect(deploymentOutbox?.eventType).toBe("deployment.requested.v1");
    const deploymentPayload = deploymentRequestedSchema.parse(deploymentOutbox?.payload);
    expect(deploymentPayload.deploymentId).toBe(result.deploymentId);
    expect(deploymentOutbox?.aggregateId).toBe(deploymentPayload.deploymentId);
  });

  it("assigns and refreshes the bounded expiry in the accepted webhook transaction", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    let receivedAt = new Date("2026-09-17T10:00:00.000Z");
    const repository = new WebhookRepository(prisma, {
      clock: () => receivedAt,
      previewTtlSeconds: 60,
    });

    await repository.process(
      input(event(fixture, "opened", "2026-09-17T09:59:00.000Z"), delivery(fixture, "ttl-open")),
    );
    const first = await prisma.previewEnvironment.findFirst({
      where: { projectId: fixture.projectId },
      select: { id: true, expiresAt: true },
    });
    expect(first?.expiresAt).toEqual(new Date("2026-09-17T10:01:00.000Z"));

    receivedAt = new Date("2026-09-17T10:05:00.000Z");
    await repository.process(
      input(
        event(fixture, "synchronize", "2026-09-17T10:04:00.000Z"),
        delivery(fixture, "ttl-refresh"),
      ),
    );
    const refreshed = await prisma.previewEnvironment.findUnique({
      where: { id: first?.id },
      select: { expiresAt: true },
    });
    expect(refreshed?.expiresAt).toEqual(new Date("2026-09-17T10:06:00.000Z"));
  });

  it("deduplicates twelve concurrent deliveries with one identity", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const opened = event(fixture, "opened", "2026-09-13T10:05:00.000Z");
    const command = input(opened, delivery(fixture, "concurrent"));

    const results = await Promise.all(
      Array.from({ length: 12 }, () => new WebhookRepository(prisma).process(command)),
    );

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(11);
    expect(await prisma.webhookDelivery.count({ where: { deliveryId: command.deliveryId } })).toBe(
      1,
    );
    expect(await prisma.pullRequest.count({ where: { projectId: fixture.projectId } })).toBe(1);
    expect(
      await prisma.deployment.count({ where: { environment: { projectId: fixture.projectId } } }),
    ).toBe(1);
  });

  it("rejects a conflicting reuse of a delivery ID without a second mutation", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new WebhookRepository(prisma);
    const first = event(fixture, "opened", "2026-09-13T10:10:00.000Z");
    const deliveryId = delivery(fixture, "conflict");
    await repository.process(input(first, deliveryId));

    const conflicting = { ...first, commitSha: "b".repeat(40) };
    await expect(repository.process(input(conflicting, deliveryId))).rejects.toBeInstanceOf(
      WebhookDeliveryConflictError,
    );
    expect(await prisma.webhookDelivery.count({ where: { deliveryId } })).toBe(1);
    expect(
      await prisma.deployment.count({ where: { environment: { projectId: fixture.projectId } } }),
    ).toBe(1);
  });

  it("does not let an older open event reopen a PR after a newer close", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new WebhookRepository(prisma);
    await repository.process(
      input(event(fixture, "opened", "2026-09-13T10:00:00.000Z"), delivery(fixture, "order-open")),
    );
    const closed = event(fixture, "closed", "2026-09-13T10:20:00.000Z");
    const closedResult = await repository.process(input(closed, delivery(fixture, "order-close")));
    const stale = await repository.process(
      input(
        event(fixture, "reopened", "2026-09-13T10:10:00.000Z"),
        delivery(fixture, "order-stale"),
      ),
    );

    expect(closedResult.deletionRequestId).toBeDefined();
    expect(stale.stale).toBe(true);
    const pullRequest = await prisma.pullRequest.findUnique({
      where: { projectId_number: { projectId: fixture.projectId, number: fixture.number } },
      include: { environment: true },
    });
    expect(pullRequest?.state).toBe("CLOSED");
    const environment = await prisma.previewEnvironment.findFirst({
      where: { projectId: fixture.projectId },
      select: { id: true },
    });
    expect(environment).not.toBeNull();
    if (!environment) throw new Error("closed webhook did not retain its environment");
    expect(
      await prisma.environmentDeletionRequest.count({ where: { environmentId: environment.id } }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateType: "environment", aggregateId: environment.id },
      }),
    ).toBe(1);
    const deletionOutbox = await prisma.outboxEvent.findFirst({
      where: { eventType: "environment.deletion-requested.v1", aggregateId: environment.id },
    });
    const deletionPayload = environmentDeletionRequestedSchema.parse(deletionOutbox?.payload);
    expect(deletionPayload.environmentId).toBe(environment.id);
    expect(deletionPayload.reason).toBe("pull_request_closed");
    expect(
      await prisma.environmentDeletionRequest.findUnique({
        where: { environmentId: environment.id },
        select: { reason: true },
      }),
    ).toEqual({ reason: "pull_request_closed" });
    expect(deletionOutbox?.aggregateId).toBe(deletionPayload.environmentId);
    expect(
      await prisma.deployment.count({ where: { environment: { projectId: fixture.projectId } } }),
    ).toBe(1);
  });

  it("reopens a closed environment with the same SHA and cancels the close request", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new WebhookRepository(prisma);
    await repository.process(
      input(event(fixture, "opened", "2026-09-13T14:00:00.000Z"), delivery(fixture, "reopen-open")),
    );
    const closed = await repository.process(
      input(
        event(fixture, "closed", "2026-09-13T14:10:00.000Z"),
        delivery(fixture, "reopen-close"),
      ),
    );
    expect(closed.deletionRequestId).toBeDefined();
    const environment = await prisma.previewEnvironment.findFirst({
      where: { projectId: fixture.projectId },
      select: { id: true },
    });
    if (!environment || !closed.deletionRequestId) throw new Error("reopen fixture is incomplete");
    await prisma.environmentDeletionRequest.update({
      where: { id: closed.deletionRequestId },
      data: { status: "PROCESSING" },
    });

    const reopened = await repository.process(
      input(
        event(fixture, "reopened", "2026-09-13T14:20:00.000Z"),
        delivery(fixture, "reopen-reopened"),
      ),
    );

    expect(reopened.deploymentId).toBeDefined();
    const pullRequest = await prisma.pullRequest.findUnique({
      where: { projectId_number: { projectId: fixture.projectId, number: fixture.number } },
      include: { environment: true },
    });
    expect(pullRequest?.state).toBe("OPEN");
    expect(
      await prisma.environmentDeletionRequest.findUnique({
        where: { environmentId: environment.id },
      }),
    ).toMatchObject({ status: "CANCELLED" });
    expect(
      await prisma.deployment.count({ where: { environment: { projectId: fixture.projectId } } }),
    ).toBe(2);
  });

  it("tracks a repository rename by immutable numeric ID without creating a second project", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new WebhookRepository(prisma);
    await repository.process(
      input(event(fixture, "opened", "2026-09-13T12:00:00.000Z"), delivery(fixture, "rename-open")),
    );

    const renamedFullName = `integration-renamed/${fixture.repositoryFullName.split("/")[1]}`;
    const renamedEvent = {
      ...event(fixture, "synchronize", "2026-09-13T12:05:00.000Z"),
      repositoryFullName: renamedFullName,
    } as const;
    const result = await repository.process(input(renamedEvent, delivery(fixture, "rename-sync")));

    expect(result.stale).toBe(false);
    expect(
      await prisma.project.count({ where: { githubRepositoryId: BigInt(fixture.repositoryId) } }),
    ).toBe(1);
    expect(
      await prisma.project.findUnique({
        where: { id: fixture.projectId },
        select: { repositoryFullName: true },
      }),
    ).toEqual({ repositoryFullName: renamedFullName });
    expect(await prisma.pullRequest.count({ where: { projectId: fixture.projectId } })).toBe(1);
  });

  it("rolls back delivery, PR, environment, and deployment when outbox creation is fault-injected", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new WebhookRepository(prisma, {
      faultInjector: (stage) => {
        if (stage === "before-outbox") throw new Error("injected webhook transaction fault");
      },
    });

    const beforeOutbox = await countOutboxForProject(prisma, fixture.projectId);
    await expect(
      repository.process(
        input(event(fixture, "opened", "2026-09-13T11:00:00.000Z"), delivery(fixture, "rollback")),
      ),
    ).rejects.toThrow("injected webhook transaction fault");
    expect(
      await prisma.webhookDelivery.count({ where: { deliveryId: delivery(fixture, "rollback") } }),
    ).toBe(0);
    expect(await prisma.pullRequest.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await prisma.previewEnvironment.count({ where: { projectId: fixture.projectId } })).toBe(
      0,
    );
    expect(
      await prisma.deployment.count({ where: { environment: { projectId: fixture.projectId } } }),
    ).toBe(0);
    expect(await countOutboxForProject(prisma, fixture.projectId)).toBe(beforeOutbox);
  });

  it("rolls back a closed delivery and deletion outbox when close fails mid-transaction", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new WebhookRepository(prisma);
    await repository.process(
      input(event(fixture, "opened", "2026-09-13T13:00:00.000Z"), delivery(fixture, "close-setup")),
    );
    const beforeOutbox = await countOutboxForProject(prisma, fixture.projectId);
    const faulted = new WebhookRepository(prisma, {
      faultInjector: () => {
        throw new Error("injected webhook close fault");
      },
    });

    await expect(
      faulted.process(
        input(
          event(fixture, "closed", "2026-09-13T13:10:00.000Z"),
          delivery(fixture, "close-rollback"),
        ),
      ),
    ).rejects.toThrow("injected webhook close fault");
    const pullRequest = await prisma.pullRequest.findUnique({
      where: { projectId_number: { projectId: fixture.projectId, number: fixture.number } },
      include: { environment: true },
    });
    expect(pullRequest?.state).toBe("OPEN");
    if (!pullRequest?.environment) throw new Error("rollback fixture lost its environment");
    expect(
      await prisma.webhookDelivery.count({
        where: { deliveryId: delivery(fixture, "close-rollback") },
      }),
    ).toBe(0);
    expect(
      await prisma.environmentDeletionRequest.count({
        where: { environmentId: pullRequest.environment.id },
      }),
    ).toBe(0);
    expect(await countOutboxForProject(prisma, fixture.projectId)).toBe(beforeOutbox);
  });
});

type Fixture = {
  userId: string;
  installationId: string;
  githubInstallationId: string;
  projectId: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  commitSha: string;
  deliveryPrefix: string;
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const repositoryId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const githubInstallationId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const repositoryFullName = `integration/${suffix}`;
  const number = 7;
  const commitSha = "a".repeat(40);
  await prisma.user.create({
    data: { id: userId, githubUserId: `webhook-${suffix}`, githubLogin: `webhook-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(githubInstallationId),
      accountLogin: `webhook-${suffix}`,
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
      repositoryFullName,
    },
  });
  return {
    userId,
    installationId,
    githubInstallationId,
    projectId,
    repositoryId,
    repositoryFullName,
    number,
    commitSha,
    deliveryPrefix: `delivery-${suffix}`,
  };
}

function delivery(fixture: Fixture, suffix: string): string {
  return `${fixture.deliveryPrefix}-${suffix}`;
}

function event(
  fixture: Fixture,
  action: "opened" | "reopened" | "synchronize" | "closed",
  sourceTimestamp: string,
) {
  return {
    action,
    installationId: fixture.githubInstallationId,
    repositoryId: fixture.repositoryId,
    repositoryFullName: fixture.repositoryFullName,
    pullRequestNumber: fixture.number,
    commitSha: fixture.commitSha,
    sourceTimestamp,
  } as const;
}

function input(eventValue: ReturnType<typeof event>, deliveryId: string) {
  const payloadSha256 = createHash("sha256").update(JSON.stringify(eventValue)).digest("hex");
  return {
    deliveryId,
    eventName: "pull_request" as const,
    payloadSha256,
    event: eventValue,
  };
}

async function cleanup(prisma: PrismaClient, fixture: Fixture): Promise<void> {
  await prisma.webhookDelivery.deleteMany({ where: { installationId: fixture.installationId } });
  const environments = await prisma.previewEnvironment.findMany({
    where: { projectId: fixture.projectId },
    select: { id: true },
  });
  const deployments = await prisma.deployment.findMany({
    where: { environment: { projectId: fixture.projectId } },
    select: { id: true },
  });
  await prisma.outboxEvent.deleteMany({
    where: {
      OR: [
        { aggregateId: { in: environments.map((row) => row.id) } },
        { aggregateId: { in: deployments.map((row) => row.id) } },
      ],
    },
  });
  await prisma.user.delete({ where: { id: fixture.userId } });
}

async function countOutboxForProject(prisma: PrismaClient, projectId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "outbox_events" WHERE "payload"->>'projectId' = ${projectId}`,
  );
  return Number(rows[0]?.count ?? 0n);
}
