import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../src/index.js";

export type DatabaseFixture = {
  userId: string;
  installationId: string;
  projectId: string;
  environmentId: string;
  deploymentId?: string;
  commitSha: string;
};

type CreateFixtureOptions = {
  commitSha?: string;
  withDeployment?: boolean;
};

/**
 * Creates an isolated ownership tree for a database test. The user is the
 * cleanup root because all relational rows below it use ON DELETE CASCADE.
 * Outbox rows are not related by a foreign key, so callers must remove those
 * explicitly with cleanupFixture.
 */
export async function createDatabaseFixture(
  prisma: PrismaClient,
  options: CreateFixtureOptions = {},
): Promise<DatabaseFixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = options.withDeployment ? randomUUID() : undefined;
  const commitSha = options.commitSha ?? sha(suffix);

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

  if (deploymentId) {
    await prisma.deployment.create({
      data: {
        id: deploymentId,
        environmentId,
        commitSha,
      },
    });
  }

  return {
    userId,
    installationId,
    projectId,
    environmentId,
    deploymentId,
    commitSha,
  };
}

export async function cleanupFixture(
  prisma: PrismaClient,
  fixture: DatabaseFixture,
  eventIds: readonly string[] = [],
): Promise<void> {
  if (eventIds.length > 0) {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: [...eventIds] } } });
  }
  await prisma.user.delete({ where: { id: fixture.userId } });
}

export function sha(seed: string): string {
  return seed.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
}

function uniqueInstallationId(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}
