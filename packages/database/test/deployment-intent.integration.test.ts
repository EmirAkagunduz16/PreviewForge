import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  DeploymentIntentConflictError,
  DeploymentIntentRepository,
  type PrismaClient,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

describe("DeploymentIntentRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let repository: DeploymentIntentRepository;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    repository = new DeploymentIntentRepository(prisma);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const fixture of fixtures) {
      await prisma.outboxEvent.deleteMany({
        where: { id: { in: fixture.eventIds } },
      });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await prisma.$disconnect();
  });

  it("commits one queued deployment and its deterministic event", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const result = await repository.createDeploymentIntent(fixture.payload);
    fixture.eventIds.push(fixture.payload.eventId);

    expect(result.created).toBe(true);
    expect(result.deployment.id).toBe(fixture.payload.deploymentId);
    expect(result.outboxEvent.id).toBe(fixture.payload.eventId);
    expect(result.outboxEvent.aggregateId).toBe(fixture.payload.deploymentId);
    expect(result.outboxEvent.eventType).toBe("deployment.requested.v1");
    expect(result.outboxEvent.payload).toEqual(fixture.payload);

    const [deploymentCount, eventCount] = await Promise.all([
      prisma.deployment.count({ where: { id: fixture.payload.deploymentId } }),
      prisma.outboxEvent.count({ where: { id: fixture.payload.eventId } }),
    ]);
    expect(deploymentCount).toBe(1);
    expect(eventCount).toBe(1);
  });

  it("makes a duplicate command harmless without adding rows", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const first = await repository.createDeploymentIntent(fixture.payload);
    fixture.eventIds.push(fixture.payload.eventId);
    const duplicate = await repository.createDeploymentIntent(fixture.payload);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.deployment.id).toBe(first.deployment.id);
    expect(duplicate.outboxEvent.id).toBe(first.outboxEvent.id);
    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      1,
    );
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: fixture.payload.deploymentId } }),
    ).toBe(1);
  });

  it("keeps an exact duplicate harmless after the desired SHA changes", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const first = await repository.createDeploymentIntent(fixture.payload);
    fixture.eventIds.push(fixture.payload.eventId);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: "b".repeat(40) },
    });

    const duplicate = await repository.createDeploymentIntent(fixture.payload);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      1,
    );
    expect(await prisma.outboxEvent.count({ where: { id: fixture.payload.eventId } })).toBe(1);
  });

  it("rejects a command that reuses a deployment identity with different event identity", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    await repository.createDeploymentIntent(fixture.payload);
    fixture.eventIds.push(fixture.payload.eventId);
    const conflictingPayload = { ...fixture.payload, eventId: randomUUID() };

    await expect(repository.createDeploymentIntent(conflictingPayload)).rejects.toBeInstanceOf(
      DeploymentIntentConflictError,
    );

    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      1,
    );
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: fixture.payload.deploymentId } }),
    ).toBe(1);
  });

  it("rolls back a deployment when an existing event identity belongs to another command", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    await repository.createDeploymentIntent(fixture.payload);
    fixture.eventIds.push(fixture.payload.eventId);
    const conflictingPayload = { ...fixture.payload, deploymentId: randomUUID() };

    await expect(repository.createDeploymentIntent(conflictingPayload)).rejects.toBeInstanceOf(
      DeploymentIntentConflictError,
    );

    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      1,
    );
    expect(
      await prisma.deployment.findUnique({ where: { id: conflictingPayload.deploymentId } }),
    ).toBe(null);
    expect(await prisma.outboxEvent.count({ where: { id: fixture.payload.eventId } })).toBe(1);
  });

  it("rolls back the deployment when its deterministic event key conflicts", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const conflictingEventId = randomUUID();
    fixture.eventIds.push(conflictingEventId);

    await prisma.outboxEvent.create({
      data: {
        id: conflictingEventId,
        eventType: "deployment.requested.v1",
        aggregateType: "deployment",
        aggregateId: randomUUID(),
        payload: { eventId: conflictingEventId },
      },
    });

    const payload = { ...fixture.payload, eventId: conflictingEventId };
    await expect(repository.createDeploymentIntent(payload)).rejects.toBeInstanceOf(
      DeploymentIntentConflictError,
    );

    expect(await prisma.deployment.count({ where: { id: fixture.payload.deploymentId } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { id: conflictingEventId } })).toBe(1);
  });
  it("deduplicates real concurrent retries to one deployment and one event", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => repository.createDeploymentIntent(fixture.payload)),
    );
    fixture.eventIds.push(fixture.payload.eventId);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.deployment.id === fixture.payload.deploymentId)).toBe(
      true,
    );
    expect(results.every((result) => result.outboxEvent.id === fixture.payload.eventId)).toBe(true);
    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      1,
    );
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: fixture.payload.deploymentId } }),
    ).toBe(1);
  });

  it("assigns distinct attempts to different intents committed concurrently", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const secondDeploymentId = randomUUID();
    const secondEventId = randomUUID();
    const secondPayload = {
      ...fixture.payload,
      eventId: secondEventId,
      deploymentId: secondDeploymentId,
      commitSha: fixture.payload.commitSha,
    };

    const results = await Promise.all([
      repository.createDeploymentIntent(fixture.payload),
      repository.createDeploymentIntent(secondPayload),
    ]);
    fixture.eventIds.push(fixture.payload.eventId, secondEventId);

    expect(results.every((result) => result.created)).toBe(true);
    expect(new Set(results.map((result) => result.deployment.attempt))).toEqual(new Set([1, 2]));
    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      2,
    );
  });

  it("rejects a stale commit intent after the environment desired SHA changes", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const replacementSha = "c".repeat(40);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: replacementSha },
    });

    await expect(repository.createDeploymentIntent(fixture.payload)).rejects.toBeInstanceOf(
      DeploymentIntentConflictError,
    );
    expect(await prisma.deployment.count({ where: { environmentId: fixture.environmentId } })).toBe(
      0,
    );
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: fixture.payload.deploymentId } }),
    ).toBe(0);
  });
});

type Fixture = {
  userId: string;
  environmentId: string;
  eventIds: string[];
  payload: {
    eventId: string;
    eventType: "deployment.requested.v1";
    occurredAt: string;
    deploymentId: string;
    environmentId: string;
    projectId: string;
    installationId: string;
    repositoryFullName: string;
    pullRequestNumber: number;
    commitSha: string;
  };
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const eventId = randomUUID();
  const repositoryFullName = `integration/${suffix}`;
  const commitSha = `${suffix.replaceAll("-", "")}${suffix.replaceAll("-", "")}`.slice(0, 40);
  const githubInstallationId = BigInt(Math.floor(Math.random() * 2_000_000_000) + 1);

  await prisma.user.create({
    data: {
      id: userId,
      githubUserId: `integration-${suffix}`,
      githubLogin: `integration-${suffix}`,
    },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId,
      accountLogin: `integration-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName,
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      previewKey: `integration-${suffix}`,
      desiredCommitSha: commitSha,
    },
  });

  return {
    userId,
    environmentId,
    eventIds: [],
    payload: {
      eventId,
      eventType: "deployment.requested.v1",
      occurredAt: "2026-09-12T17:00:00.000Z",
      deploymentId,
      environmentId,
      projectId,
      installationId: githubInstallationId.toString(),
      repositoryFullName,
      pullRequestNumber: 7,
      commitSha,
    },
  };
}
