import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../src/index.js";
import { ProjectIdentityConflictError, ProjectRepository } from "../src/project-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

describe("ProjectRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let repository: ProjectRepository;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    repository = new ProjectRepository(prisma);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("is idempotent and updates a repository rename without creating a second project", async () => {
    const fixture = await createFixture(prisma, userIds);
    const first = await repository.importProject(input(fixture, { fullName: "octo/old-name" }));
    const renamed = await repository.importProject(
      input(fixture, {
        fullName: "octo/new-name",
        dockerfilePath: "deploy/Dockerfile",
        port: 8080,
        healthPath: "/ready",
      }),
    );

    expect(renamed.id).toBe(first.id);
    expect(renamed.githubRepositoryId).toBe(fixture.repositoryId);
    expect(renamed.repositoryFullName).toBe("octo/new-name");
    expect(renamed.dockerfilePath).toBe("deploy/Dockerfile");
    expect(renamed.containerPort).toBe(8080);
    expect(renamed.healthPath).toBe("/ready");
    expect(
      await prisma.project.count({ where: { githubRepositoryId: BigInt(fixture.repositoryId) } }),
    ).toBe(1);
  });

  it("keeps concurrent first imports on one row", async () => {
    const fixture = await createFixture(prisma, userIds);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => repository.importProject(input(fixture))),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(
      await prisma.project.count({ where: { githubRepositoryId: BigInt(fixture.repositoryId) } }),
    ).toBe(1);
  });

  it("loads the external installation ID and runtime fields for a build", async () => {
    const fixture = await createFixture(prisma, userIds);
    const imported = await repository.importProject(
      input(fixture, { port: 8080, healthPath: "/health" }),
    );
    const installation = await prisma.installation.findUniqueOrThrow({
      where: { id: fixture.installationId },
      select: { githubInstallationId: true },
    });

    await expect(repository.findBuildById(imported.id)).resolves.toEqual({
      id: imported.id,
      githubInstallationId: installation.githubInstallationId.toString(),
      repositoryFullName: "octo/example",
      dockerfilePath: "Dockerfile",
      containerPort: 8080,
      healthPath: "/health",
    });
  });

  it("rejects a repository identity crossing an owner or installation boundary", async () => {
    const first = await createFixture(prisma, userIds);
    const second = await createFixture(prisma, userIds);
    await repository.importProject(input(first));

    await expect(
      repository.importProject(input(second, { repositoryId: first.repositoryId })),
    ).rejects.toBeInstanceOf(ProjectIdentityConflictError);
    expect(
      await prisma.project.count({ where: { githubRepositoryId: BigInt(first.repositoryId) } }),
    ).toBe(1);
  });

  it("turns a same-installation full-name collision into a typed conflict", async () => {
    const fixture = await createFixture(prisma, userIds);
    await repository.importProject(input(fixture));

    await expect(
      repository.importProject(
        input(fixture, {
          repositoryId: `${BigInt(fixture.repositoryId) + 1n}`,
          fullName: "octo/example",
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectIdentityConflictError);
  });

  it("turns a concurrent full-name collision into one success and one typed conflict", async () => {
    const fixture = await createFixture(prisma, userIds);
    const outcomes = await Promise.allSettled([
      repository.importProject(input(fixture, { repositoryId: fixture.repositoryId })),
      repository.importProject(
        input(fixture, { repositoryId: `${BigInt(fixture.repositoryId) + 1n}` }),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      ProjectIdentityConflictError,
    );
  });

  it("persists only the validated project configuration shape", async () => {
    const fixture = await createFixture(prisma, userIds);
    const imported = await repository.importProject(
      input(fixture, {
        dockerfilePath: "containers/Dockerfile.preview",
        port: 65535,
        healthPath: "/health/live",
      }),
    );
    const stored = await prisma.project.findUnique({ where: { id: imported.id } });
    expect(stored).toMatchObject({
      githubRepositoryId: BigInt(fixture.repositoryId),
      dockerfilePath: "containers/Dockerfile.preview",
      containerPort: 65535,
      healthPath: "/health/live",
    });

    await expect(
      prisma.project.update({
        where: { id: imported.id },
        data: { dockerfilePath: "../Dockerfile" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({ where: { id: imported.id }, data: { healthPath: "https://secret" } }),
    ).rejects.toThrow();
  });
});

type Fixture = {
  userId: string;
  installationId: string;
  repositoryId: string;
};

async function createFixture(prisma: PrismaClient, userIds: string[]): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const repositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  userIds.push(userId);
  await prisma.user.create({
    data: {
      id: userId,
      githubUserId: `project-import-${suffix}`,
      githubLogin: `project-import-${suffix}`,
    },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1_000_000)}`),
      accountLogin: `project-import-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  return { userId, installationId, repositoryId };
}

function input(
  fixture: Fixture,
  options: {
    fullName?: string;
    repositoryId?: string;
    dockerfilePath?: string;
    port?: number;
    healthPath?: string;
  } = {},
) {
  return {
    installationId: fixture.installationId,
    ownerId: fixture.userId,
    githubRepositoryId: options.repositoryId ?? fixture.repositoryId,
    repositoryFullName: options.fullName ?? "octo/example",
    dockerfilePath: options.dockerfilePath ?? "Dockerfile",
    containerPort: options.port ?? 3000,
    healthPath: options.healthPath ?? "/",
  };
}
