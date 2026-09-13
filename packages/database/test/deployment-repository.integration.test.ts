import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  DeploymentRepository,
  DeploymentTransitionError,
  type PrismaClient,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

describe("DeploymentRepository (PostgreSQL)", () => {
  const prisma = createPrismaClient(databaseUrl);
  const repository = new DeploymentRepository(prisma);
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    await prisma?.$connect();
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: { in: [fixture.deploymentId] },
        },
      });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await prisma?.$disconnect();
  });

  it("applies a legal compare-and-set transition and persists its event", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "CLONING",
      expectedDesiredSha: fixture.commitSha,
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.deployment.status).toBe("CLONING");

    const [deployment, events] = await Promise.all([
      prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
      prisma.outboxEvent.findMany({ where: { aggregateId: fixture.deploymentId } }),
    ]);
    expect(deployment?.status).toBe("CLONING");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: result.outboxEventId,
      aggregateType: "deployment",
      eventType: "deployment.stage-changed.v1",
    });
  });

  it("rejects an illegal transition without changing database state", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    await expect(
      repository.transition({
        deploymentId: fixture.deploymentId,
        expectedStatus: "QUEUED",
        to: "READY",
        expectedDesiredSha: fixture.commitSha,
      }),
    ).rejects.toBeInstanceOf(DeploymentTransitionError);

    const [deployment, eventCount] = await Promise.all([
      prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
      prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } }),
    ]);
    expect(deployment?.status).toBe("QUEUED");
    expect(eventCount).toBe(0);
  });

  it("does not advance stale work after the environment desired SHA changes", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const replacementSha = sha("new");

    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: replacementSha },
    });

    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "CLONING",
      expectedDesiredSha: fixture.commitSha,
    });

    expect(result).toEqual({
      applied: false,
      reason: "DESIRED_SHA_MISMATCH",
      currentStatus: "QUEUED",
    });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "QUEUED",
      commitSha: fixture.commitSha,
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      0,
    );
  });

  it("stores durable failure fields and redacts credentials in state and events", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const secret = "ghp_should-never-be-persisted";
    const bearer = "Bearer bearer-secret";
    const apiKey = "api_key=api-secret";

    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "FAILED",
      expectedDesiredSha: fixture.commitSha,
      failure: {
        stage: "BUILDING",
        code: "BUILD_FAILED",
        message: `build failed with ${secret}; authorization ${bearer}; ${apiKey}`,
        retryable: false,
      },
    });

    expect(result.applied).toBe(true);
    const [deployment, event] = await Promise.all([
      prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
      prisma.outboxEvent.findFirst({ where: { aggregateId: fixture.deploymentId } }),
    ]);
    expect(deployment).toMatchObject({
      status: "FAILED",
      failureStage: "BUILDING",
      failureCode: "BUILD_FAILED",
      failureRetryable: false,
    });
    expect(deployment?.failureMessage).toContain("[REDACTED]");
    expect(deployment?.failureMessage).not.toContain(secret);
    expect(deployment?.failureMessage).not.toContain(bearer);
    expect(deployment?.failureMessage).not.toContain(apiKey);
    expect(JSON.stringify(event?.payload)).not.toContain(secret);
    expect(JSON.stringify(event?.payload)).not.toContain(bearer);
    expect(JSON.stringify(event?.payload)).not.toContain(apiKey);
  });

  it("never rewinds a terminal deployment", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "FAILED",
      expectedDesiredSha: fixture.commitSha,
      failure: {
        stage: "BUILDING",
        code: "BUILD_FAILED",
        message: "deterministic build failure",
        retryable: false,
      },
    });

    await expect(
      repository.transition({
        deploymentId: fixture.deploymentId,
        expectedStatus: "FAILED",
        to: "QUEUED",
        expectedDesiredSha: fixture.commitSha,
      }),
    ).rejects.toBeInstanceOf(DeploymentTransitionError);

    const deployment = await prisma.deployment.findUnique({
      where: { id: fixture.deploymentId },
    });
    expect(deployment?.status).toBe("FAILED");
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      1,
    );
  });

  it("supersedes a READY deployment only after a newer desired SHA exists", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    for (const [expectedStatus, to] of [
      ["QUEUED", "CLONING"],
      ["CLONING", "BUILDING"],
      ["BUILDING", "PUSHING"],
      ["PUSHING", "DEPLOYING"],
      ["DEPLOYING", "WAITING_FOR_HEALTHCHECK"],
      ["WAITING_FOR_HEALTHCHECK", "READY"],
    ] as const) {
      const result = await repository.transition({
        deploymentId: fixture.deploymentId,
        expectedStatus,
        to,
        expectedDesiredSha: fixture.commitSha,
      });
      expect(result.applied).toBe(true);
    }

    const unchanged = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "READY",
      to: "SUPERSEDED",
      expectedDesiredSha: fixture.commitSha,
    });
    expect(unchanged).toEqual({
      applied: false,
      reason: "DESIRED_SHA_MISMATCH",
      currentStatus: "READY",
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      6,
    );

    const replacementSha = "b".repeat(40);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: replacementSha },
    });
    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "READY",
      to: "SUPERSEDED",
      expectedDesiredSha: replacementSha,
    });
    expect(result).toMatchObject({ applied: true, eventType: "deployment.stage-changed.v1" });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      7,
    );
  });

  it("marks active stale work superseded with the newer desired-SHA token", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    expect(
      await repository.transition({
        deploymentId: fixture.deploymentId,
        expectedStatus: "QUEUED",
        to: "CLONING",
        expectedDesiredSha: fixture.commitSha,
      }),
    ).toMatchObject({ applied: true });

    const replacementSha = "c".repeat(40);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: replacementSha },
    });

    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "CLONING",
      to: "SUPERSEDED",
      expectedDesiredSha: replacementSha,
    });
    expect(result).toMatchObject({ applied: true, eventType: "deployment.stage-changed.v1" });

    const deployment = await prisma.deployment.findUnique({
      where: { id: fixture.deploymentId },
    });
    expect(deployment).toMatchObject({
      status: "SUPERSEDED",
      finishedAt: expect.any(Date),
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      2,
    );
  });

  it("allows only one concurrent compare-and-set transition to win", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.transition({
          deploymentId: fixture.deploymentId,
          expectedStatus: "QUEUED",
          to: "CLONING",
          expectedDesiredSha: fixture.commitSha,
        }),
      ),
    );

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.applied)
        .every((result) =>
          ["EXPECTED_STATUS_MISMATCH", "TERMINAL", "DESIRED_SHA_MISMATCH"].includes(result.reason),
        ),
    ).toBe(true);
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "CLONING",
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      1,
    );
  });

  it("requires the explicit desired-SHA token and emits no event on mismatch", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "CLONING",
      expectedDesiredSha: "d".repeat(40),
    });

    expect(result).toEqual({
      applied: false,
      reason: "DESIRED_SHA_MISMATCH",
      currentStatus: "QUEUED",
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      0,
    );
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "QUEUED",
    });
  });

  it("rejects stale work after a desired-SHA compare-and-set update", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const replacementSha = "e".repeat(40);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: replacementSha },
    });

    const result = await repository.transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "CLONING",
      expectedDesiredSha: fixture.commitSha,
    });
    expect(result).toMatchObject({
      applied: false,
      reason: "DESIRED_SHA_MISMATCH",
      currentStatus: "QUEUED",
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      0,
    );
  });
});

type Fixture = {
  userId: string;
  environmentId: string;
  deploymentId: string;
  commitSha: string;
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const commitSha = sha(suffix);

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
      githubInstallationId: BigInt(uniqueInstallationId()),
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
      repositoryFullName: `integration/${suffix}`,
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
  await prisma.deployment.create({
    data: {
      id: deploymentId,
      environmentId,
      commitSha,
    },
  });

  return { userId, environmentId, deploymentId, commitSha };
}

function sha(seed: string): string {
  return seed.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
}

function uniqueInstallationId(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}
