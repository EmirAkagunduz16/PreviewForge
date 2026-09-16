import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createPrismaClient,
  DeploymentRepository,
  hashOpaqueValue,
  LogChunkRepository,
  type PrismaClient,
} from "@previewforge/database";
import { CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for M6 integrated acceptance");

describe("M6 integrated API acceptance (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ownerSession = `m6-acceptance-owner-${suffix}`;
  const foreignSession = `m6-acceptance-foreign-${suffix}`;
  const fixtureUserIds: string[] = [];
  const deploymentIds: string[] = [];
  const streamControllers: AbortController[] = [];
  let prisma: PrismaClient;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let origin = "";
  let owner: Fixture;
  let foreign: Fixture;

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    owner = await seedFixture(
      prisma,
      fixtureUserIds,
      deploymentIds,
      ownerSession,
      suffix,
      "owner",
      [
        { status: "BUILDING", number: 41, commitSha: "a".repeat(40) },
        { status: "WAITING_FOR_HEALTHCHECK", number: 42, commitSha: "b".repeat(40) },
      ],
    );
    foreign = await seedFixture(
      prisma,
      fixtureUserIds,
      deploymentIds,
      foreignSession,
      suffix,
      "foreign",
      [{ status: "BUILDING", number: 43, commitSha: "c".repeat(40) }],
    );

    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app = await createApplication({
      host: "127.0.0.1",
      logLevel: "error",
      nodeEnv: "test",
      port: 0,
      databaseUrl,
      encryptionKey: Buffer.alloc(32, 23),
      publicBaseUrl: "http://previewforge.test",
      sessionTtlSeconds: 3600,
      oauthStateTtlSeconds: 600,
      github: {
        appId: "123",
        clientId: "m6-acceptance-client",
        clientSecret: "unused-test-client-secret",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret: "unused-test-webhook-secret",
        appSlug: "previewforge-test",
        apiBaseUrl: "http://127.0.0.1:9",
        oauthBaseUrl: "http://127.0.0.1:9",
      },
    });
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  });

  afterAll(async () => {
    for (const controller of streamControllers) controller.abort();
    let cleanupError: unknown;
    try {
      if (app) await app.close();
      if (deploymentIds.length > 0) {
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: deploymentIds } } });
      }
      if (fixtureUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } });
      }
      const [users, projects, environments, deployments, logs, variables, outbox] =
        await Promise.all([
          prisma.user.count({ where: { id: { in: fixtureUserIds } } }),
          prisma.project.count({ where: { ownerId: { in: fixtureUserIds } } }),
          prisma.previewEnvironment.count({
            where: { project: { ownerId: { in: fixtureUserIds } } },
          }),
          prisma.deployment.count({ where: { id: { in: deploymentIds } } }),
          prisma.logChunk.count({ where: { deploymentId: { in: deploymentIds } } }),
          prisma.projectEnvironmentVariable.count({
            where: { project: { ownerId: { in: fixtureUserIds } } },
          }),
          prisma.outboxEvent.count({ where: { aggregateId: { in: deploymentIds } } }),
        ]);
      expect({ users, projects, environments, deployments, logs, variables, outbox }).toEqual({
        users: 0,
        projects: 0,
        environments: 0,
        deployments: 0,
        logs: 0,
        variables: 0,
        outbox: 0,
      });
    } catch (error) {
      cleanupError = error;
    } finally {
      if (prisma) await prisma.$disconnect();
    }
    if (cleanupError !== undefined) throw cleanupError;
  }, 30_000);

  it("keeps dashboard reads owner-scoped and persists a redacted durable failure", async () => {
    const unauthenticated = await fetch(`${origin}/api/projects`);
    expect(unauthenticated.status).toBe(401);

    const projects = await request("/api/projects");
    expect(projects.status).toBe(200);
    expect((await projects.json()).items.map((item: { id: string }) => item.id)).toEqual([
      owner.projectId,
    ]);

    const foreignProject = await request(`/api/projects/${foreign.projectId}/previews`);
    expect(foreignProject.status).toBe(404);
    const hiddenDeployment = await request(
      `/api/deployments/${required(foreign.deploymentIds[0], "foreign deployment")}`,
    );
    expect(hiddenDeployment.status).toBe(404);

    const injectedFailure = `token ghp_m6-acceptance-secret-${suffix}`;
    const failedDeploymentId = required(owner.deploymentIds[1], "owner failed deployment");
    const transitioned = await new DeploymentRepository(prisma).transition({
      deploymentId: failedDeploymentId,
      expectedStatus: "WAITING_FOR_HEALTHCHECK",
      to: "FAILED",
      expectedDesiredSha: "b".repeat(40),
      failure: {
        stage: "HEALTHCHECK",
        code: "HEALTHCHECK_FAILED",
        message: injectedFailure,
        retryable: false,
      },
    });
    expect(transitioned.applied).toBe(true);

    const detail = await request(`/api/deployments/${failedDeploymentId}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      id: failedDeploymentId,
      status: "FAILED",
      failureStage: "HEALTHCHECK",
      failureCode: "HEALTHCHECK_FAILED",
      failureRetryable: false,
    });
    expect(JSON.stringify(detailBody)).not.toContain(injectedFailure);

    const durable = await prisma.deployment.findUniqueOrThrow({
      where: { id: failedDeploymentId },
      select: { failureMessage: true, status: true },
    });
    expect(durable).toEqual({
      status: "FAILED",
      failureMessage: "token [REDACTED]",
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: failedDeploymentId },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(event.payload)).not.toContain(injectedFailure);
  });

  it("keeps environment values write-only and resumes ordered durable SSE logs", async () => {
    const projectPath = `/api/projects/${owner.projectId}/environment-variables`;
    const secretValue = `m6-write-only-${suffix}`;
    const saved = await request(`${projectPath}/TOKEN`, {
      method: "PUT",
      origin: "http://previewforge.test",
      body: { value: secretValue },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ key: "TOKEN" });

    const listed = await request(projectPath);
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toEqual({ items: [{ key: "TOKEN" }] });
    expect(listedText).not.toContain(secretValue);

    const stored = await prisma.projectEnvironmentVariable.findUniqueOrThrow({
      where: { projectId_key: { projectId: owner.projectId, key: "TOKEN" } },
    });
    expect(stored.encryptedValue).not.toContain(secretValue);
    expect(
      new CredentialCipher(Buffer.alloc(32, 23)).decrypt(
        stored.encryptedValue,
        projectEnvironmentAssociatedData(owner.projectId, "TOKEN"),
      ),
    ).toBe(secretValue);

    const foreignWrite = await request(
      `/api/projects/${foreign.projectId}/environment-variables/TOKEN`,
      { method: "PUT", origin: "http://previewforge.test", body: { value: "must-not-write" } },
    );
    expect(foreignWrite.status).toBe(404);

    const logs = new LogChunkRepository(prisma);
    const liveDeploymentId = required(owner.deploymentIds[0], "owner live deployment");
    await appendLog(logs, liveDeploymentId, "first durable log");
    await appendLog(logs, liveDeploymentId, "second durable log");
    const persisted = await logs.readPage(owner.userId, liveDeploymentId, {
      after: 0,
      limit: 10,
    });
    expect(persisted).toMatchObject({
      kind: "found",
      chunks: [
        { sequence: 1, text: "first durable log" },
        { sequence: 2, text: "second durable log" },
      ],
    });

    const unauthenticated = await fetch(`${origin}/api/deployments/${liveDeploymentId}/events`);
    expect(unauthenticated.status).toBe(401);
    const foreignStream = await request(`/api/deployments/${liveDeploymentId}/events`, {
      session: foreignSession,
    });
    expect(foreignStream.status).toBe(404);

    const controller = new AbortController();
    streamControllers.push(controller);
    const stream = await fetch(`${origin}/api/deployments/${liveDeploymentId}/events`, {
      headers: {
        cookie: `previewforge_session=${ownerSession}`,
        "last-event-id": "1",
      },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const frames = await readSseFrames(stream, 2);
    expect(frames[0]).toMatchObject({ event: "status" });
    expect(frames[1]).toMatchObject({ event: "log", id: "2" });
    const logFrame = frames[1];
    if (!logFrame?.data) throw new Error("SSE log frame has no data");
    expect(JSON.parse(logFrame.data)).toMatchObject({
      sequence: 2,
      text: "second durable log",
    });
    controller.abort();

    const deleted = await request(`${projectPath}/TOKEN`, {
      method: "DELETE",
      origin: "http://previewforge.test",
    });
    expect(deleted.status).toBe(200);
    expect(
      await prisma.projectEnvironmentVariable.count({ where: { projectId: owner.projectId } }),
    ).toBe(0);
  }, 30_000);

  async function request(
    path: string,
    options: {
      session?: string;
      method?: string;
      origin?: string;
      body?: unknown;
    } = {},
  ): Promise<Response> {
    const session = options.session ?? ownerSession;
    return fetch(`${origin}${path}`, {
      method: options.method ?? "GET",
      headers: {
        cookie: `previewforge_session=${session}`,
        ...(options.origin === undefined ? {} : { Origin: options.origin }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function appendLog(logs: LogChunkRepository, deploymentId: string, text: string) {
    const appended = await logs.append({
      deploymentId,
      desiredSha: "a".repeat(40),
      stage: "BUILDING",
      stream: "stdout",
      text,
    });
    expect(appended).not.toBeNull();
  }
});

type Fixture = {
  userId: string;
  projectId: string;
  deploymentIds: string[];
};

async function seedFixture(
  prisma: PrismaClient,
  fixtureUserIds: string[],
  deploymentIdsForCleanup: string[],
  sessionToken: string,
  suffix: string,
  label: string,
  deployments: Array<{ status: string; number: number; commitSha: string }>,
): Promise<Fixture> {
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  fixtureUserIds.push(userId);
  await prisma.user.create({
    data: {
      id: userId,
      githubUserId: `m6-acceptance-${label}-${suffix}`,
      githubLogin: `m6-${label}`,
    },
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
      githubInstallationId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 10_000)),
      accountLogin: `m6-${label}`,
      accountType: "User",
      encryptedPrivateKey: `must-not-return-${label}`,
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `integration/m6-acceptance-${label}`,
      dockerfilePath: "Dockerfile",
      containerPort: 3000,
      healthPath: "/health",
    },
  });

  const deploymentIds: string[] = [];
  for (const fixture of deployments) {
    const pullRequestId = randomUUID();
    const environmentId = randomUUID();
    const deploymentId = randomUUID();
    await prisma.pullRequest.create({
      data: {
        id: pullRequestId,
        projectId,
        number: fixture.number,
        title: `M6 acceptance ${label} #${fixture.number}`,
        headSha: fixture.commitSha,
        state: "OPEN",
      },
    });
    await prisma.previewEnvironment.create({
      data: {
        id: environmentId,
        projectId,
        pullRequestId,
        previewKey: `m6-acceptance-${label}-${fixture.number}-${suffix}`,
        desiredCommitSha: fixture.commitSha,
        status: "ACTIVE",
      },
    });
    await prisma.deployment.create({
      data: {
        id: deploymentId,
        environmentId,
        attempt: 1,
        commitSha: fixture.commitSha,
        status: fixture.status,
      },
    });
    deploymentIds.push(deploymentId);
    deploymentIdsForCleanup.push(deploymentId);
  }
  return { userId, projectId, deploymentIds };
}

type SseFrame = { event: string; id?: string; data?: string };

async function readSseFrames(response: Response, count: number): Promise<SseFrame[]> {
  if (!response.body) throw new Error("SSE response has no readable body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  try {
    while (frames.length < count) {
      const next = await reader.read();
      if (next.done) throw new Error("SSE stream ended before expected frames");
      buffer += decoder.decode(next.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (raw.length > 0) frames.push(parseSseFrame(raw));
        if (frames.length >= count) break;
        boundary = buffer.indexOf("\n\n");
      }
    }
    return frames;
  } finally {
    await reader.cancel();
  }
}

function parseSseFrame(raw: string): SseFrame {
  const frame: SseFrame = { event: "message" };
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") frame.event = value;
    if (field === "id") frame.id = value;
    if (field === "data") data.push(value);
  }
  if (data.length > 0) frame.data = data.join("\n");
  return frame;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label} fixture`);
  return value;
}
