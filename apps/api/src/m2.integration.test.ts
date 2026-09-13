import { createHmac, generateKeyPairSync, randomInt } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPrismaClient, hashOpaqueValue, type PrismaClient } from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the M2 HTTP integration test");

describe("M2 GitHub App HTTP vertical slice", () => {
  const suffix = `${Date.now() % 1_000_000_000}${randomInt(10_000, 99_999)}`;
  const githubUserId = suffix;
  const githubAccountId = `${BigInt(suffix) + 1n}`;
  const githubInstallationId = `${BigInt(suffix) + 2n}`;
  const githubRepositoryId = `${BigInt(suffix) + 3n}`;
  const repositoryFullName = `previewforge/m2-${suffix}`;
  const webhookSecret = "m2-http-webhook-secret";
  const userAccessToken = "ghu-short-lived-test-token";
  const installationAccessToken = "ghs-short-lived-test-token";
  const oauthStates: string[] = [];
  const requestedPaths: string[] = [];
  let githubOrigin = "";
  let prisma: PrismaClient;
  let githubServer: ReturnType<typeof createServer>;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let apiOrigin = "";

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    githubServer = createServer((request, response) => {
      void handleGitHubRequest(request, response).catch(() => {
        response.writeHead(500).end();
      });
    });
    githubServer.listen(0, "127.0.0.1");
    await once(githubServer, "listening");
    const address = githubServer.address();
    if (!address || typeof address === "string") throw new Error("Fake GitHub server did not bind");
    githubOrigin = `http://127.0.0.1:${address.port}`;

    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app = await createApplication({
      host: "127.0.0.1",
      logLevel: "error",
      nodeEnv: "test",
      port: 0,
      databaseUrl,
      encryptionKey: Buffer.alloc(32, 9),
      publicBaseUrl: "http://previewforge.test",
      sessionTtlSeconds: 3600,
      oauthStateTtlSeconds: 600,
      github: {
        appId: "123",
        clientId: "client-id",
        clientSecret: "client-secret",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret,
        appSlug: "previewforge-test",
        apiBaseUrl: githubOrigin,
        oauthBaseUrl: githubOrigin,
      },
    });
    await app.listen(0, "127.0.0.1");
    apiOrigin = await app.getUrl();
  });

  afterAll(async () => {
    if (prisma) await cleanup();
    if (app) await app.close();
    if (githubServer) {
      githubServer.close();
      await once(githubServer, "close");
    }
    if (prisma) await prisma.$disconnect();
  });

  it("signs in, verifies an installation, imports a repository, and deduplicates raw webhooks", async () => {
    const signInStart = await fetch(`${apiOrigin}/api/auth/github/start`, { redirect: "manual" });
    expect(signInStart.status).toBe(302);
    const signInLocation = requiredHeader(signInStart, "location");
    const signInUrl = new URL(signInLocation);
    expect(signInUrl.origin).toBe(githubOrigin);
    expect(signInUrl.searchParams.get("redirect_uri")).toBe(
      "http://previewforge.test/api/auth/github/callback",
    );
    const signInState = requiredQuery(signInUrl, "state");
    oauthStates.push(signInState);
    const signInBinding = responseCookie(signInStart, "previewforge_oauth_binding");

    const signInCallback = await fetch(
      `${apiOrigin}/api/auth/github/callback?code=valid-code&state=${encodeURIComponent(signInState)}`,
      { headers: { cookie: `previewforge_oauth_binding=${signInBinding}` }, redirect: "manual" },
    );
    expect(signInCallback.status).toBe(302);
    const session = responseCookie(signInCallback, "previewforge_session");
    expect(session).not.toContain(userAccessToken);

    const installationStart = await fetch(`${apiOrigin}/api/installations/github/start`, {
      headers: { cookie: `previewforge_session=${session}` },
      redirect: "manual",
    });
    expect(installationStart.status).toBe(302);
    const installationUrl = new URL(requiredHeader(installationStart, "location"));
    expect(installationUrl.pathname).toBe("/apps/previewforge-test/installations/new");
    expect(installationUrl.searchParams.get("redirect_uri")).toBe(
      "http://previewforge.test/api/installations/github/callback",
    );
    const installationState = requiredQuery(installationUrl, "state");
    oauthStates.push(installationState);
    const installationBinding = responseCookie(installationStart, "previewforge_oauth_binding");

    const installationCallback = await fetch(
      `${apiOrigin}/api/installations/github/callback?installation_id=${githubInstallationId}&state=${encodeURIComponent(installationState)}`,
      {
        headers: {
          cookie: `previewforge_session=${session}; previewforge_oauth_binding=${installationBinding}`,
        },
        redirect: "manual",
      },
    );
    expect(installationCallback.status).toBe(302);

    const listed = await fetch(
      `${apiOrigin}/api/projects/repositories?installation_id=${githubInstallationId}`,
      { headers: { cookie: `previewforge_session=${session}` } },
    );
    expect(listed.status).toBe(200);
    const listedRepositories = (await listed.json()) as Array<Record<string, unknown>>;
    expect(listedRepositories).toContainEqual(
      expect.objectContaining({
        id: githubRepositoryId,
        fullName: repositoryFullName,
        pull: true,
      }),
    );
    expect(JSON.stringify(listedRepositories)).not.toContain("permissions");

    const imported = await fetch(`${apiOrigin}/api/projects/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `previewforge_session=${session}`,
      },
      body: JSON.stringify({
        installationId: githubInstallationId,
        repositoryId: githubRepositoryId,
        repositoryFullName,
        dockerfilePath: "Dockerfile",
        port: 3000,
        healthPath: "/health",
      }),
    });
    expect(imported.status).toBe(201);
    const importedProject = (await imported.json()) as Record<string, unknown>;
    expect(importedProject).toMatchObject({
      githubRepositoryId,
      repositoryFullName,
      dockerfilePath: "Dockerfile",
      containerPort: 3000,
      healthPath: "/health",
    });
    expect(JSON.stringify(importedProject)).not.toContain("token");

    const webhookBody = Buffer.from(
      JSON.stringify({
        action: "opened",
        number: 17,
        installation: { id: Number(githubInstallationId) },
        repository: { id: Number(githubRepositoryId), full_name: repositoryFullName },
        pull_request: {
          id: Number(githubRepositoryId) + 10,
          number: 17,
          head: { sha: "a".repeat(40) },
          updated_at: "2026-09-13T12:00:00.000Z",
        },
      }),
    );
    const deliveryId = `m2-http-${suffix}`;
    const webhookResponses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`${apiOrigin}/api/webhooks/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "pull_request",
            "x-github-delivery": deliveryId,
            "x-hub-signature-256": signature(webhookBody),
          },
          body: webhookBody,
        }),
      ),
    );
    expect(webhookResponses.map((response) => response.status)).toEqual(
      Array.from({ length: 12 }, () => 201),
    );
    const webhookResults = (await Promise.all(
      webhookResponses.map((response) => response.json()),
    )) as Array<{ duplicate: boolean }>;
    expect(webhookResults.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(webhookResults.filter((result) => result.duplicate)).toHaveLength(11);

    const prettyBody = Buffer.from(JSON.stringify(JSON.parse(webhookBody.toString()), null, 2));
    const invalidDeliveryId = `${deliveryId}-invalid-signature`;
    const invalidSignature = await fetch(`${apiOrigin}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": invalidDeliveryId,
        "x-hub-signature-256": signature(webhookBody),
      },
      body: prettyBody,
    });
    expect(invalidSignature.status).toBe(401);

    const project = await prisma.project.findUnique({
      where: { githubRepositoryId: BigInt(githubRepositoryId) },
      include: { pullRequests: { include: { environment: { include: { deployments: true } } } } },
    });
    expect(project).not.toBeNull();
    expect(project?.pullRequests).toHaveLength(1);
    expect(project?.pullRequests[0]?.environment?.deployments).toHaveLength(1);
    expect(await prisma.webhookDelivery.count({ where: { deliveryId } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { deliveryId: invalidDeliveryId } })).toBe(
      0,
    );
    const user = await prisma.user.findUnique({ where: { githubNumericId: BigInt(githubUserId) } });
    expect(user).not.toBeNull();
    if (!user) throw new Error("Expected imported user");
    const credential = await prisma.gitHubCredential.findUnique({ where: { userId: user.id } });
    expect(credential?.encryptedAccessToken).not.toContain(userAccessToken);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(requestedPaths.filter((path) => path.includes("/repositories"))).toHaveLength(4);
  });

  async function handleGitHubRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", githubOrigin);
    requestedPaths.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const body = new URLSearchParams(await requestText(request));
      if (
        body.get("code") !== "valid-code" ||
        !body.get("code_verifier") ||
        body.get("redirect_uri") !== "http://previewforge.test/api/auth/github/callback"
      ) {
        return json(response, 400, { error: "bad_verification_code" });
      }
      return json(response, 200, {
        access_token: userAccessToken,
        token_type: "bearer",
        scope: "",
      });
    }
    if (request.method === "GET" && url.pathname === "/user") {
      requireBearer(request, userAccessToken);
      return json(response, 200, { id: githubUserId, login: `m2-user-${suffix}` });
    }
    if (
      request.method === "GET" &&
      url.pathname === `/user/installations/${githubInstallationId}`
    ) {
      requireBearer(request, userAccessToken);
      return json(response, 200, installationPayload());
    }
    if (request.method === "GET" && url.pathname === `/app/installations/${githubInstallationId}`) {
      requireJwt(request);
      return json(response, 200, installationPayload());
    }
    if (
      request.method === "GET" &&
      url.pathname === `/user/installations/${githubInstallationId}/repositories`
    ) {
      requireBearer(request, userAccessToken);
      if (url.searchParams.get("page") === "2") {
        return json(response, 200, {
          total_count: 2,
          repositories: [repositoryPayload(`${BigInt(githubRepositoryId) + 1n}`, "second", true)],
        });
      }
      response.setHeader(
        "link",
        `<${githubOrigin}/user/installations/${githubInstallationId}/repositories?per_page=100&page=2>; rel="next"`,
      );
      return json(response, 200, {
        total_count: 2,
        repositories: [repositoryPayload(githubRepositoryId, repositoryFullName, true)],
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === `/app/installations/${githubInstallationId}/access_tokens`
    ) {
      requireJwt(request);
      return json(response, 201, {
        token: installationAccessToken,
        expires_at: "2030-01-01T00:00:00Z",
      });
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/repos/previewforge/${encodeURIComponent(`m2-${suffix}`)}/contents/Dockerfile`
    ) {
      requireBearer(request, installationAccessToken);
      return json(response, 200, { type: "file", path: "Dockerfile", sha: "b".repeat(40) });
    }
    return json(response, 404, { message: "not found" });
  }

  function installationPayload() {
    return {
      id: githubInstallationId,
      account: {
        id: githubAccountId,
        login: `m2-account-${suffix}`,
        type: "Organization",
      },
    };
  }

  function repositoryPayload(id: string, fullName: string, pull: boolean) {
    const name = fullName.includes("/") ? fullName.split("/")[1] : fullName;
    return {
      id,
      name,
      full_name: fullName.includes("/") ? fullName : `previewforge/${fullName}`,
      default_branch: "main",
      permissions: { pull, push: true, admin: true },
    };
  }

  async function cleanup() {
    const project = await prisma.project.findUnique({
      where: { githubRepositoryId: BigInt(githubRepositoryId) },
      include: { pullRequests: { include: { environment: { include: { deployments: true } } } } },
    });
    const aggregateIds = [
      project?.id,
      ...(project?.pullRequests ?? []).flatMap((pullRequest) => [
        pullRequest.environment?.id,
        ...(pullRequest.environment?.deployments.map((deployment) => deployment.id) ?? []),
      ]),
    ].filter((value): value is string => Boolean(value));
    if (aggregateIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
    }
    await prisma.webhookDelivery.deleteMany({
      where: { deliveryId: { startsWith: `m2-http-${suffix}` } },
    });
    const user = await prisma.user.findUnique({ where: { githubNumericId: BigInt(githubUserId) } });
    if (user) await prisma.user.delete({ where: { id: user.id } });
    if (oauthStates.length > 0) {
      await prisma.oAuthState.deleteMany({
        where: { stateHash: { in: oauthStates.map(hashOpaqueValue) } },
      });
    }
  }

  function signature(body: Uint8Array): string {
    return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
  }
});

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requireBearer(request: IncomingMessage, token: string): void {
  if (request.headers.authorization !== `Bearer ${token}`) {
    throw new Error("Expected bearer token");
  }
}

function requireJwt(request: IncomingMessage): void {
  if (!request.headers.authorization?.startsWith("Bearer eyJ")) {
    throw new Error("Expected GitHub App JWT");
  }
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Missing ${name} response header`);
  return value;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing ${name} query parameter`);
  return value;
}

function responseCookie(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
  if (!match?.[1]) throw new Error(`Missing ${name} cookie`);
  return decodeURIComponent(match[1]);
}
