import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

describe("M2 GitHub App migration (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const pullRequestId = randomUUID();
  const sessionId = randomUUID();
  const oauthStateId = randomUUID();
  const credentialId = randomUUID();
  const deletionRequestId = randomUUID();

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) return;
    // Delete only this test's ownership tree; never truncate or reset the
    // shared database used by the other integration suites.
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("exposes additive M2 tables, BIGINT identity columns, and safety constraints", async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('sessions', 'oauth_states', 'github_credentials', 'environment_deletion_requests')
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      "environment_deletion_requests",
      "github_credentials",
      "oauth_states",
      "sessions",
    ]);

    const columns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string }>
    >`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'installations' AND column_name IN ('github_installation_id', 'github_account_id'))
          OR (table_name = 'projects' AND column_name = 'github_repository_id'))
      ORDER BY table_name
    `;
    expect(columns).toEqual([
      { table_name: "installations", column_name: "github_installation_id", data_type: "bigint" },
      { table_name: "installations", column_name: "github_account_id", data_type: "bigint" },
      { table_name: "projects", column_name: "github_repository_id", data_type: "bigint" },
    ]);
  });

  it("persists hashes/ciphertext and validates identity, import, ordering, and deletion data", async () => {
    const now = new Date();
    const sourceUpdatedAt = new Date(now.getTime() + 1_000);

    await prisma.user.create({
      data: {
        id: userId,
        githubUserId: `m2-${userId}`,
        githubNumericId: 9_007_199_254_740_993n,
        githubLogin: "m2-owner",
      },
    });
    await prisma.installation.create({
      data: {
        id: installationId,
        githubInstallationId: 2_000_000_001,
        githubAccountId: 9_007_199_254_740_995n,
        accountLogin: "m2-owner",
        accountType: "Organization",
        ownerId: userId,
      },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        installationId,
        ownerId: userId,
        githubRepositoryId: 9_007_199_254_740_997n,
        repositoryFullName: "m2-owner/preview",
        dockerfilePath: "infra/Dockerfile.preview",
        containerPort: 8080,
        healthPath: "/healthz",
      },
    });
    await prisma.pullRequest.create({
      data: {
        id: pullRequestId,
        projectId,
        number: 42,
        headSha: "a".repeat(40),
        sourceUpdatedAt,
        lastWebhookDeliveryId: "m2-delivery-1",
        lastWebhookEvent: "pull_request",
        lastWebhookAt: now,
      },
    });
    await prisma.previewEnvironment.create({
      data: {
        id: environmentId,
        projectId,
        pullRequestId,
        previewKey: `m2-${environmentId}`,
        desiredCommitSha: "a".repeat(40),
      },
    });
    await prisma.session.create({
      data: {
        id: sessionId,
        tokenHash: "a".repeat(64),
        userId,
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
    });
    await prisma.oAuthState.create({
      data: {
        id: oauthStateId,
        stateHash: "b".repeat(64),
        bindingHash: "c".repeat(64),
        encryptedPkceVerifier: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA",
        flow: "SIGN_IN",
        userId,
        expiresAt: new Date(now.getTime() + 600_000),
      },
    });
    await prisma.gitHubCredential.create({
      data: {
        id: credentialId,
        userId,
        encryptedAccessToken: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.YWNjZXNzLWNpcGhlcnRleHQ",
        encryptedRefreshToken:
          "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.cmVmcmVzaC1jaXBoZXJ0ZXh0",
        accessTokenExpiresAt: new Date(now.getTime() + 3_600_000),
        refreshTokenExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
        scopes: [],
      },
    });
    await prisma.environmentDeletionRequest.create({
      data: {
        id: deletionRequestId,
        environmentId,
        requestKey: "m2-delivery-closed-1",
        sourceUpdatedAt,
        sourceDeliveryId: "m2-delivery-closed-1",
      },
    });

    const [project, pullRequest, session, state, credential, deletion] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId } }),
      prisma.pullRequest.findUnique({ where: { id: pullRequestId } }),
      prisma.session.findUnique({ where: { id: sessionId } }),
      prisma.oAuthState.findUnique({ where: { id: oauthStateId } }),
      prisma.gitHubCredential.findUnique({ where: { id: credentialId } }),
      prisma.environmentDeletionRequest.findUnique({ where: { id: deletionRequestId } }),
    ]);
    expect(project).toMatchObject({
      githubRepositoryId: 9_007_199_254_740_997n,
      dockerfilePath: "infra/Dockerfile.preview",
      containerPort: 8080,
      healthPath: "/healthz",
    });
    expect(pullRequest?.sourceUpdatedAt).toEqual(sourceUpdatedAt);
    expect(session?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state?.bindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state?.encryptedPkceVerifier).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(credential?.encryptedAccessToken).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(credential?.encryptedRefreshToken).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(JSON.stringify({ state, credential })).not.toContain("plaintext");
    expect(deletion).toMatchObject({
      status: "REQUESTED",
      sourceDeliveryId: "m2-delivery-closed-1",
    });
  });

  it("enforces first-owner, immutable IDs, and one-time OAuth consumption", async () => {
    await expect(
      prisma.installation.update({
        where: { id: installationId },
        data: { ownerId: randomUUID() },
      }),
    ).rejects.toThrow(/owner is immutable/i);
    await expect(
      prisma.project.update({ where: { id: projectId }, data: { githubRepositoryId: 123n } }),
    ).rejects.toThrow(/repository identity is immutable/i);
    await expect(
      prisma.installation.update({
        where: { id: installationId },
        data: { githubInstallationId: 2_147_483_648n },
      }),
    ).rejects.toThrow(/installation identity is immutable/i);

    await prisma.oAuthState.update({
      where: { id: oauthStateId },
      data: { consumedAt: new Date() },
    });
    await expect(
      prisma.oAuthState.update({ where: { id: oauthStateId }, data: { consumedAt: null } }),
    ).rejects.toThrow(/already been consumed/i);
  });

  it("rejects unsafe project settings at the PostgreSQL boundary", async () => {
    await expect(
      prisma.project.update({ where: { id: projectId }, data: { containerPort: 0 } }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { dockerfilePath: "../Dockerfile" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({ where: { id: projectId }, data: { healthPath: "https://internal" } }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { healthPath: "/health\ncheck" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { dockerfilePath: "docker//Dockerfile" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { dockerfilePath: "docker/./Dockerfile" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { dockerfilePath: "docker\\Dockerfile" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { dockerfilePath: "docker/../Dockerfile" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { healthPath: "/health?ready=1" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { healthPath: "/health#ready" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { healthPath: "/health/../ready" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.project.update({
        where: { id: projectId },
        data: { healthPath: "/health\\ready" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.session.create({
        data: {
          id: randomUUID(),
          tokenHash: `sha256:${"d".repeat(64)}`,
          userId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.oAuthState.create({
        data: {
          id: randomUUID(),
          stateHash: "E".repeat(64),
          bindingHash: "f".repeat(64),
          encryptedPkceVerifier: "v1.A.A.A",
          flow: "SIGN_IN",
          userId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });
});
