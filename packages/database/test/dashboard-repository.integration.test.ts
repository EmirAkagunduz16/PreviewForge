import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, DashboardRepository, type PrismaClient } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

describe("DashboardRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let repository: DashboardRepository;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    repository = new DashboardRepository(prisma);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("returns safe owner-scoped projections and stable cursor pages for dashboard queries", async () => {
    const owner = await makeOwner(prisma, userIds);
    const other = await makeOwner(prisma, userIds);
    const older = await makeProject(prisma, owner.userId, owner.installationId, -20);
    const newer = await makeProject(prisma, owner.userId, owner.installationId, -10);
    const foreign = await makeProject(prisma, other.userId, other.installationId, -30);

    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);
    const oldEnv = await makeEnvironment(prisma, older.id, "old", 17, "CLOSED", sha1, -3);
    const env = await makeEnvironment(prisma, newer.id, "desired", 42, "OPEN", sha2, -2);
    const missingDeploymentEnv = await makeEnvironment(
      prisma,
      newer.id,
      "not-yet-deployed",
      43,
      "OPEN",
      "3".repeat(40),
      -1,
    );
    const foreignEnv = await makeEnvironment(prisma, foreign.id, "foreign", 5, "OPEN", sha1, 0);

    const stale = await prisma.deployment.create({
      data: {
        environmentId: env.id,
        attempt: 1,
        commitSha: sha1,
        status: "SUPERSEDED",
        createdAt: new Date("2026-01-01T00:00:01Z"),
      },
    });
    const current = await prisma.deployment.create({
      data: {
        environmentId: env.id,
        attempt: 2,
        commitSha: sha2,
        status: "FAILED",
        failureStage: "WAITING_FOR_HEALTHCHECK",
        failureCode: "HEALTHCHECK_FAILED",
        failureMessage: "health endpoint returned 500",
        failureRetryable: false,
        imageDigest: `sha256:${"a".repeat(64)}`,
        createdAt: new Date("2026-01-01T00:00:01Z"),
      },
    });
    await prisma.deployment.create({
      data: { environmentId: oldEnv.id, attempt: 1, commitSha: sha1, status: "READY" },
    });
    await prisma.deployment.create({
      data: { environmentId: foreignEnv.id, attempt: 1, commitSha: sha1, status: "READY" },
    });

    const firstProjectPage = await repository.listProjects(owner.userId, { limit: 1 });
    expect(firstProjectPage.items.map((item) => item.id)).toEqual([newer.id]);
    expect(firstProjectPage.nextCursor).toEqual({ id: newer.id, createdAt: newer.createdAt });
    const secondProjectPage = await repository.listProjects(owner.userId, {
      limit: 1,
      cursor: firstProjectPage.nextCursor ?? undefined,
    });
    expect(secondProjectPage.items.map((item) => item.id)).toEqual([older.id]);
    expect(JSON.stringify(firstProjectPage.items)).not.toMatch(
      /ownerId|installationId|credential|secret/i,
    );

    expect(await repository.hasOwnedProject(owner.userId, newer.id)).toBe(true);
    expect(await repository.hasOwnedProject(owner.userId, foreign.id)).toBe(false);
    expect(await repository.hasOwnedProject(owner.userId, randomUUID())).toBe(false);

    const previews = await repository.listPreviews(owner.userId, newer.id, { limit: 20 });
    expect(previews.items).toHaveLength(2);
    expect(previews.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: env.id,
          desiredCommitSha: sha2,
          pullRequest: expect.objectContaining({ number: 42, headSha: sha2, state: "OPEN" }),
          currentDeployment: expect.objectContaining({
            id: current.id,
            attempt: 2,
            commitSha: sha2,
          }),
        }),
        expect.objectContaining({
          id: missingDeploymentEnv.id,
          currentDeployment: null,
        }),
      ]),
    );

    const firstHistoryPage = await repository.listDeployments(owner.userId, newer.id, { limit: 1 });
    const secondHistoryPage = await repository.listDeployments(owner.userId, newer.id, {
      limit: 1,
      cursor: firstHistoryPage.nextCursor ?? undefined,
    });
    expect(firstHistoryPage.items).toHaveLength(1);
    expect(secondHistoryPage.items).toHaveLength(1);
    expect([firstHistoryPage.items[0]?.id, secondHistoryPage.items[0]?.id]).toEqual(
      [current.id, stale.id].sort((left, right) => right.localeCompare(left)),
    );
    expect([...firstHistoryPage.items, ...secondHistoryPage.items]).toContainEqual(
      expect.objectContaining({
        id: current.id,
        failureCode: "HEALTHCHECK_FAILED",
        failureRetryable: false,
        imageDigest: `sha256:${"a".repeat(64)}`,
        environment: expect.objectContaining({
          desiredCommitSha: sha2,
          pullRequest: { number: 42, title: "PR 42", id: expect.any(String), state: "OPEN" },
        }),
      }),
    );
    expect(await repository.listDeployments(owner.userId, foreign.id, { limit: 20 })).toMatchObject(
      {
        items: [],
        nextCursor: null,
      },
    );

    const detail = await repository.findDeployment(owner.userId, current.id);
    expect(detail).toMatchObject({
      id: current.id,
      status: "FAILED",
      environment: {
        desiredCommitSha: sha2,
        pullRequest: { number: 42, headSha: sha2 },
        project: { id: newer.id, repositoryFullName: newer.repositoryFullName },
      },
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /leaseToken|leaseOwner|checkRunId|installation|credential/i,
    );
    expect(await repository.findDeployment(owner.userId, current.id)).not.toBeNull();
    expect(await repository.findDeployment(owner.userId, randomUUID())).toBeNull();
    expect(
      await repository.findDeployment(
        owner.userId,
        (
          await prisma.deployment.findFirstOrThrow({
            where: { environmentId: foreignEnv.id },
            select: { id: true },
          })
        ).id,
      ),
    ).toBeNull();
  });
});

async function makeOwner(prisma: PrismaClient, userIds: string[]) {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  userIds.push(userId);
  await prisma.user.create({ data: { id: userId, githubUserId: suffix, githubLogin: suffix } });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Date.now()) + BigInt(userIds.length),
      accountLogin: suffix,
      accountType: "User",
      ownerId: userId,
    },
  });
  return { userId, installationId };
}

async function makeProject(
  prisma: PrismaClient,
  ownerId: string,
  installationId: string,
  offsetDays: number,
) {
  const id = randomUUID();
  const suffix = randomUUID();
  const createdAt = new Date(Date.now() + offsetDays * 86_400_000);
  return prisma.project.create({
    data: {
      id,
      installationId,
      ownerId,
      repositoryFullName: `integration/${suffix}`,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

async function makeEnvironment(
  prisma: PrismaClient,
  projectId: string,
  previewKey: string,
  number: number,
  state: string,
  desiredCommitSha: string,
  offsetDays: number,
) {
  const pullRequestId = randomUUID();
  const createdAt = new Date(Date.now() + offsetDays * 86_400_000);
  const pullRequest = await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number,
      title: `PR ${number}`,
      headSha: desiredCommitSha,
      state,
      createdAt,
      updatedAt: createdAt,
    },
  });
  return prisma.previewEnvironment.create({
    data: {
      projectId,
      pullRequestId: pullRequest.id,
      previewKey: `${previewKey}-${randomUUID()}`,
      desiredCommitSha,
      createdAt,
      updatedAt: createdAt,
    },
  });
}
