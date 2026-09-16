import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createPrismaClient, hashOpaqueValue, type PrismaClient } from "@previewforge/database";
import { CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for environment variable integration tests");

describe("environment-variable HTTP integration (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ownerSession = `env-owner-${suffix}`;
  const foreignSession = `env-foreign-${suffix}`;
  const ownerId = randomUUID();
  const foreignId = randomUUID();
  const ownerInstall = randomUUID();
  const foreignInstall = randomUUID();
  const projectId = randomUUID();
  const foreignProjectId = randomUUID();
  const createdUserIds: string[] = [];
  let prisma: PrismaClient;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let origin = "";

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    for (const [id, login, session, installationId, project] of [
      [ownerId, `owner-${suffix}`, ownerSession, ownerInstall, projectId],
      [foreignId, `foreign-${suffix}`, foreignSession, foreignInstall, foreignProjectId],
    ] as const) {
      await prisma.user.create({ data: { id, githubUserId: login, githubLogin: login } });
      createdUserIds.push(id);
      await prisma.installation.create({
        data: {
          id: installationId,
          githubInstallationId: BigInt(Math.floor(Math.random() * 1_000_000_000) + 1),
          accountLogin: login,
          accountType: "User",
          ownerId: id,
        },
      });
      await prisma.project.create({
        data: {
          id: project,
          installationId,
          ownerId: id,
          repositoryFullName: `integration/${login}`,
        },
      });
      await prisma.session.create({
        data: {
          tokenHash: hashOpaqueValue(session),
          userId: id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app = await createApplication({
      host: "127.0.0.1",
      logLevel: "error",
      nodeEnv: "test",
      port: 0,
      databaseUrl,
      encryptionKey: Buffer.alloc(32, 19),
      publicBaseUrl: "http://previewforge.test",
      sessionTtlSeconds: 3600,
      oauthStateTtlSeconds: 600,
      github: {
        appId: "123",
        clientId: "client",
        clientSecret: "test-client-secret",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret: "test-webhook",
        appSlug: "previewforge-test",
        apiBaseUrl: "http://127.0.0.1:9",
        oauthBaseUrl: "http://127.0.0.1:9",
      },
    });
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        expect(
          await prisma.projectEnvironmentVariable.count({
            where: { projectId: { in: [projectId, foreignProjectId] } },
          }),
        ).toBe(0);
      }
      await prisma.$disconnect();
    }
  });

  it("enforces auth/origin/ownership and returns names-only while supporting replace/delete", async () => {
    const unauthenticated = await fetch(
      `${origin}/api/projects/${projectId}/environment-variables`,
    );
    expect(unauthenticated.status).toBe(401);
    const base = `/api/projects/${projectId}/environment-variables`;
    const foreign = await call(base, foreignSession);
    const absent = await call(`/api/projects/${randomUUID()}/environment-variables`, ownerSession);
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(stableError(await foreign.json())).toEqual(stableError(await absent.json()));
    const foreignWrite = await call(
      `/api/projects/${foreignProjectId}/environment-variables/TOKEN`,
      ownerSession,
      "PUT",
      { value: "must-not-write" },
    );
    const absentWrite = await call(
      `/api/projects/${randomUUID()}/environment-variables/TOKEN`,
      ownerSession,
      "PUT",
      { value: "must-not-write" },
    );
    expect(foreignWrite.status).toBe(404);
    expect(absentWrite.status).toBe(404);
    expect(stableError(await foreignWrite.json())).toEqual(stableError(await absentWrite.json()));

    const rejectedOrigin = await call(
      `${base}/TOKEN`,
      ownerSession,
      "PUT",
      { value: "hidden" },
      "https://evil.test",
    );
    expect(rejectedOrigin.status).toBe(400);
    const invalidValue = await call(`${base}/TOKEN`, ownerSession, "PUT", {
      value: "é".repeat(8193),
    });
    expect(invalidValue.status).toBe(400);
    const secretValue = `secret-${randomUUID()}`;
    const saved = await call(`${base}/TOKEN`, ownerSession, "PUT", { value: secretValue });
    expect(saved.status).toBe(200);
    const responseText = await saved.text();
    expect(responseText).not.toContain(secretValue);
    expect(responseText).not.toContain("encryptedValue");
    expect(JSON.parse(responseText)).toEqual({ key: "TOKEN" });
    const stored = await prisma.projectEnvironmentVariable.findUniqueOrThrow({
      where: { projectId_key: { projectId, key: "TOKEN" } },
    });
    expect(stored.encryptedValue).not.toContain(secretValue);
    const listed = await call(base, ownerSession);
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toEqual({ items: [{ key: "TOKEN" }] });
    expect(listedText).not.toContain(secretValue);
    expect(listedText).not.toContain("encryptedValue");
    expect(listedText).not.toContain("ownerId");
    const replacement = await call(`${base}/TOKEN`, ownerSession, "PUT", {
      value: "replaced-value",
    });
    expect(replacement.status).toBe(200);
    const replacementRecord = await prisma.projectEnvironmentVariable.findUniqueOrThrow({
      where: { projectId_key: { projectId, key: "TOKEN" } },
    });
    expect(replacementRecord.encryptedValue).not.toBe(stored.encryptedValue);
    expect(
      new CredentialCipher(Buffer.alloc(32, 19)).decrypt(
        replacementRecord.encryptedValue,
        projectEnvironmentAssociatedData(projectId, "TOKEN"),
      ),
    ).toBe("replaced-value");
    const deleted = await call(`${base}/TOKEN`, ownerSession, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await prisma.projectEnvironmentVariable.count({ where: { projectId } })).toBe(0);
  });

  async function call(
    path: string,
    session = ownerSession,
    method = "GET",
    body?: unknown,
    requestOrigin = "http://previewforge.test",
  ) {
    return fetch(`${origin}${path}`, {
      method,
      headers: {
        Cookie: `previewforge_session=${session}`,
        Origin: requestOrigin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
});

function stableError(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return error;
  const { requestId: _requestId, ...stable } = error as Record<string, unknown>;
  return stable;
}
