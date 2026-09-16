import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createPrismaClient, hashOpaqueValue, type PrismaClient } from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for the M6 dashboard HTTP integration test");

describe("M6 dashboard query HTTP integration (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ownerSession = `m6-owner-${suffix}`;
  const foreignSession = `m6-foreign-${suffix}`;
  const ownerIds: string[] = [];
  let prisma: PrismaClient;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let apiOrigin = "";
  let ownerUserId = "";
  let ownerProjectId = "";
  let foreignProjectId = "";
  let ownerDeploymentId = "";
  let foreignDeploymentId = "";

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    const owner = await seedOwner(prisma, ownerIds, ownerSession, suffix, "owner");
    const foreign = await seedOwner(prisma, ownerIds, foreignSession, suffix, "foreign");
    ownerUserId = owner.userId;
    ownerProjectId = owner.projectId;
    foreignProjectId = foreign.projectId;
    ownerDeploymentId = owner.deploymentId;
    foreignDeploymentId = foreign.deploymentId;

    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app = await createApplication({
      host: "127.0.0.1",
      logLevel: "error",
      nodeEnv: "test",
      port: 0,
      databaseUrl,
      encryptionKey: Buffer.alloc(32, 13),
      publicBaseUrl: "http://previewforge.test",
      sessionTtlSeconds: 3600,
      oauthStateTtlSeconds: 600,
      github: {
        appId: "123",
        clientId: "client-id",
        clientSecret: "unused-test-client-secret",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret: "unused-test-webhook-secret",
        appSlug: "previewforge-test",
        apiBaseUrl: "http://127.0.0.1:9",
        oauthBaseUrl: "http://127.0.0.1:9",
      },
    });
    await app.listen(0, "127.0.0.1");
    apiOrigin = await app.getUrl();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (ownerIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    if (prisma) await prisma.$disconnect();
  });

  it("serves owner-only projections and hides foreign/missing resources consistently", async () => {
    const unauthenticated = await fetch(`${apiOrigin}/api/projects`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", statusCode: 401 },
    });

    const projectsResponse = await request("/api/projects?limit=20");
    expect(projectsResponse.status).toBe(200);
    const projects = (await projectsResponse.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(projects.items).toHaveLength(1);
    expect(projects.items[0]).toMatchObject({
      id: ownerProjectId,
      repositoryFullName: "integration/m6-owner",
      defaultBranch: "main",
      dockerfilePath: "Dockerfile",
      containerPort: 3000,
      healthPath: "/health",
    });
    expect(Object.keys(projects.items[0] ?? {}).sort()).toEqual(
      [
        "id",
        "repositoryFullName",
        "defaultBranch",
        "dockerfilePath",
        "containerPort",
        "healthPath",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(projects.items.map((project) => project.id)).not.toContain(foreignProjectId);
    expect(projects.nextCursor).toBeNull();
    assertNoSensitiveProjectionFields(projects);

    const previewsResponse = await request(`/api/projects/${ownerProjectId}/previews`);
    expect(previewsResponse.status).toBe(200);
    const previews = (await previewsResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(previews.items).toHaveLength(1);
    expect(previews.items[0]).toMatchObject({
      desiredCommitSha: "a".repeat(40),
      status: "ACTIVE",
      pullRequest: { number: 42, title: "M6 owner fixture", state: "OPEN" },
      currentDeployment: { id: ownerDeploymentId, status: "READY", attempt: 1 },
    });
    assertNoSensitiveProjectionFields(previews);

    const historyResponse = await request(`/api/projects/${ownerProjectId}/deployments`);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      id: ownerDeploymentId,
      status: "READY",
      commitSha: "a".repeat(40),
      imageDigest: `sha256:${"a".repeat(64)}`,
      environment: { desiredCommitSha: "a".repeat(40), pullRequest: { number: 42 } },
    });
    assertNoSensitiveProjectionFields(history);

    const detailResponse = await request(`/api/deployments/${ownerDeploymentId}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    const durableDetail = await prisma.deployment.findFirstOrThrow({
      where: { id: ownerDeploymentId, environment: { project: { ownerId: ownerUserId } } },
      select: {
        id: true,
        attempt: true,
        commitSha: true,
        status: true,
        failureStage: true,
        failureCode: true,
        failureMessage: true,
        failureRetryable: true,
        imageDigest: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(detail).toMatchObject(
      JSON.parse(JSON.stringify(durableDetail)) as Record<string, unknown>,
    );
    expect(detail).toMatchObject({
      environment: {
        desiredCommitSha: durableDetail.commitSha,
        project: { id: ownerProjectId, repositoryFullName: "integration/m6-owner" },
      },
    });
    assertNoSensitiveProjectionFields(detail);

    const absentProjectId = randomUUID();
    const absentDeploymentId = randomUUID();
    const hiddenAndMissing = await Promise.all([
      request(`/api/projects/${foreignProjectId}/previews`, ownerSession),
      request(`/api/projects/${absentProjectId}/previews`, ownerSession),
      request(`/api/projects/${foreignProjectId}/deployments`, ownerSession),
      request(`/api/projects/${absentProjectId}/deployments`, ownerSession),
      request(`/api/deployments/${foreignDeploymentId}`, ownerSession),
      request(`/api/deployments/${absentDeploymentId}`, ownerSession),
    ]);
    for (const response of hiddenAndMissing) expect(response.status).toBe(404);
    const envelopes = await Promise.all(hiddenAndMissing.map(async (response) => response.json()));
    const normalized = envelopes.map(({ error }: { error: Record<string, unknown> }) => {
      const { requestId: _requestId, ...stableError } = error;
      return stableError;
    });
    expect(normalized).toEqual(Array.from({ length: 6 }, () => normalized[0]));
    expect(normalized[0]).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });

    for (const path of [
      "/api/projects?limit=0",
      "/api/projects?limit=101",
      "/api/projects?cursor=invalid",
    ]) {
      const invalid = await request(path);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: "BAD_REQUEST", statusCode: 400 },
      });
    }
  });

  function request(path: string, session = ownerSession) {
    return fetch(`${apiOrigin}${path}`, {
      headers: {
        cookie: `previewforge_session=${session}`,
        "x-request-id": "m6-query-http-test",
      },
    });
  }
});

async function seedOwner(
  prisma: PrismaClient,
  cleanupUserIds: string[],
  sessionToken: string,
  suffix: string,
  label: string,
) {
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const pullRequestId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  cleanupUserIds.push(userId);
  await prisma.user.create({
    data: { id: userId, githubUserId: `m6-${label}-${suffix}`, githubLogin: `m6-${label}` },
  });
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashOpaqueValue(sessionToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Date.now()) + BigInt(cleanupUserIds.length),
      accountLogin: `m6-${label}`,
      accountType: "User",
      encryptedPrivateKey: `must-not-return-${label}-ciphertext`,
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `integration/m6-${label}`,
      dockerfilePath: "Dockerfile",
      containerPort: 3000,
      healthPath: "/health",
    },
  });
  const commitSha = "a".repeat(40);
  await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number: label === "owner" ? 42 : 43,
      title: `M6 ${label} fixture`,
      headSha: commitSha,
      state: "OPEN",
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      pullRequestId,
      previewKey: `m6-${label}-${suffix}`,
      desiredCommitSha: commitSha,
      status: "ACTIVE",
    },
  });
  await prisma.deployment.create({
    data: {
      id: deploymentId,
      environmentId,
      attempt: 1,
      commitSha,
      status: "READY",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
  });
  return { userId, projectId, deploymentId };
}

function assertNoSensitiveProjectionFields(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(
    /ownerId|installationId|encryptedPrivateKey|credential|session|leaseToken|leaseOwner|secretValue/i,
  );
}
