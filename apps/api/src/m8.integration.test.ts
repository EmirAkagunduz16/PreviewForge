import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, WebhookRepository } from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";
import {
  githubSignature,
  loadGithubWebhookFixture,
  type M8GithubFixtureIds,
} from "./test-support/m8/github-fixtures.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for M8 API failure-injection tests");

const webhookSecret = "m8-api-webhook-secret";
const numericIdentityBase = BigInt(Date.now()) * 1_000n + BigInt(randomInt(100, 999));

describe("M8 API webhook lifecycle and transaction faults", () => {
  const suffix = `${Date.now()}-${randomInt(100_000, 999_999)}`;
  const ids: M8GithubFixtureIds = {
    installationId: (numericIdentityBase + 1n).toString(),
    repositoryId: (numericIdentityBase + 2n).toString(),
    pullRequestId: (numericIdentityBase + 3n).toString(),
    repositoryFullName: `previewforge/m8-${suffix}`,
  };
  const userId = randomUUID();
  const installationRowId = randomUUID();
  const projectId = randomUUID();
  const deliveryIds: string[] = [];
  const deploymentIds: string[] = [];
  let environmentId = "";
  let prisma: PrismaClient;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let apiOrigin = "";
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const failedSha = "c".repeat(40);

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: userId,
        githubUserId: `m8-api-user-${suffix}`,
        githubNumericId: numericIdentityBase + 4n,
        githubLogin: `m8-api-${suffix}`,
      },
    });
    await prisma.installation.create({
      data: {
        id: installationRowId,
        githubInstallationId: BigInt(ids.installationId),
        githubAccountId: BigInt(ids.repositoryId),
        accountLogin: `m8-api-${suffix}`,
        accountType: "User",
        encryptedPrivateKey: "m8-test-private-key-must-not-leak",
        ownerId: userId,
      },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        installationId: installationRowId,
        ownerId: userId,
        githubRepositoryId: BigInt(ids.repositoryId),
        repositoryFullName: ids.repositoryFullName,
        healthPath: "/health",
      },
    });

    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app = await createApplication({
      host: "127.0.0.1",
      logLevel: "error",
      nodeEnv: "test",
      port: 0,
      databaseUrl,
      encryptionKey: Buffer.alloc(32, 41),
      publicBaseUrl: "http://previewforge.test",
      sessionTtlSeconds: 3600,
      oauthStateTtlSeconds: 600,
      github: {
        appId: "m8-api-test-app",
        clientId: "m8-api-test-client",
        clientSecret: "m8-api-test-client-secret",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret,
        appSlug: "previewforge-m8-test",
        apiBaseUrl: "http://127.0.0.1:9",
        oauthBaseUrl: "http://127.0.0.1:9",
      },
    });
    await app.listen(0, "127.0.0.1");
    apiOrigin = await app.getUrl();
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (app) await app.close();
      if (prisma) {
        await prisma.outboxEvent.deleteMany({
          where: {
            OR: [
              ...(deploymentIds.length === 0 ? [] : [{ aggregateId: { in: deploymentIds } }]),
              ...(environmentId === "" ? [] : [{ aggregateId: environmentId }]),
            ],
          },
        });
        await prisma.webhookDelivery.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
        await prisma.user.deleteMany({ where: { id: userId } });

        const [
          users,
          installations,
          projects,
          pullRequests,
          environments,
          deployments,
          deliveries,
          outbox,
        ] = await Promise.all([
          prisma.user.count({ where: { id: userId } }),
          prisma.installation.count({ where: { id: installationRowId } }),
          prisma.project.count({ where: { id: projectId } }),
          prisma.pullRequest.count({ where: { projectId } }),
          prisma.previewEnvironment.count({ where: { projectId } }),
          prisma.deployment.count({ where: { id: { in: deploymentIds } } }),
          prisma.webhookDelivery.count({ where: { deliveryId: { in: deliveryIds } } }),
          prisma.outboxEvent.count({
            where: {
              OR: [
                ...(deploymentIds.length === 0 ? [] : [{ aggregateId: { in: deploymentIds } }]),
                ...(environmentId === "" ? [] : [{ aggregateId: environmentId }]),
              ],
            },
          }),
        ]);
        expect({
          users,
          installations,
          projects,
          pullRequests,
          environments,
          deployments,
          deliveries,
          outbox,
        }).toEqual({
          users: 0,
          installations: 0,
          projects: 0,
          pullRequests: 0,
          environments: 0,
          deployments: 0,
          deliveries: 0,
          outbox: 0,
        });
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      if (prisma) await prisma.$disconnect();
    }
    if (cleanupError !== undefined) throw cleanupError;
  }, 30_000);

  it("accepts raw signed fixtures, deduplicates/reorders them, and emits durable lifecycle facts", async () => {
    const opened = loadGithubWebhookFixture("pull-request-opened.json", ids, { oldSha });
    const synchronize = loadGithubWebhookFixture("pull-request-synchronize.json", ids, { newSha });
    const closed = loadGithubWebhookFixture("pull-request-closed.json", ids, { newSha });

    const openedResult = await postWebhook(opened, "m8-api-opened-v1");
    expect(openedResult.response.status).toBe(201);
    expect(openedResult.body).toMatchObject({ action: "opened", duplicate: false, stale: false });
    const firstDeploymentId = requiredString(openedResult.body.deploymentId, "opened deploymentId");
    deploymentIds.push(firstDeploymentId);

    const duplicateOpened = await postWebhook(opened, "m8-api-opened-v1");
    expect(duplicateOpened.response.status).toBe(201);
    expect(duplicateOpened.body).toMatchObject({ duplicate: true, stale: false });

    const synchronized = await postWebhook(synchronize, "m8-api-synchronize-v1");
    expect(synchronized.response.status).toBe(201);
    expect(synchronized.body).toMatchObject({
      action: "synchronize",
      duplicate: false,
      stale: false,
    });
    const secondDeploymentId = requiredString(
      synchronized.body.deploymentId,
      "synchronize deploymentId",
    );
    deploymentIds.push(secondDeploymentId);

    const delayedOpened = await postWebhook(opened, "m8-api-delayed-opened-v1");
    expect(delayedOpened.response.status).toBe(201);
    expect(delayedOpened.body).toMatchObject({ duplicate: false, stale: true });
    expect(delayedOpened.body.deploymentId).toBeUndefined();

    const closedResult = await postWebhook(closed, "m8-api-closed-v1");
    expect(closedResult.response.status).toBe(201);
    expect(closedResult.body).toMatchObject({ action: "closed", duplicate: false, stale: false });
    const deletionRequestId = requiredString(
      closedResult.body.deletionRequestId,
      "deletion request id",
    );
    deliveryIds.push(
      "m8-api-opened-v1",
      "m8-api-synchronize-v1",
      "m8-api-delayed-opened-v1",
      "m8-api-closed-v1",
    );

    const duplicateClosed = await postWebhook(closed, "m8-api-closed-v1");
    expect(duplicateClosed.response.status).toBe(201);
    expect(duplicateClosed.body).toMatchObject({ duplicate: true });

    const environment = await prisma.previewEnvironment.findFirstOrThrow({
      where: { id: { not: "00000000-0000-4000-8000-000000000000" }, projectId },
      include: { deployments: { orderBy: { attempt: "asc" } }, deletionRequest: true },
    });
    environmentId = environment.id;
    expect(environment.desiredCommitSha).toBe(newSha);
    expect(environment.status).toBe("ACTIVE");
    expect(environment.deletionRequest).toMatchObject({
      id: deletionRequestId,
      status: "REQUESTED",
    });
    expect(
      environment.deployments.map((deployment) => ({
        attempt: deployment.attempt,
        commitSha: deployment.commitSha,
      })),
    ).toEqual([
      { attempt: 1, commitSha: oldSha },
      { attempt: 2, commitSha: newSha },
    ]);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { deliveryId: { in: deliveryIds } },
      orderBy: { deliveryId: "asc" },
      select: { deliveryId: true, status: true, duplicateOfDeliveryId: true },
    });
    expect(deliveries).toHaveLength(4);
    expect(
      deliveries.find((delivery) => delivery.deliveryId === "m8-api-delayed-opened-v1"),
    ).toMatchObject({
      status: "IGNORED_STALE",
    });
    expect(deliveries.find((delivery) => delivery.deliveryId === "m8-api-opened-v1")).toMatchObject(
      {
        status: "PROCESSED",
      },
    );

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: { in: [...deploymentIds, environment.id] } },
      orderBy: { createdAt: "asc" },
      select: { eventType: true, aggregateId: true, payload: true },
    });
    expect(outbox.map((event) => event.eventType)).toEqual([
      "deployment.requested.v1",
      "deployment.requested.v1",
      "environment.deletion-requested.v1",
    ]);
    expect(JSON.stringify(outbox)).not.toContain(webhookSecret);
    expect(JSON.stringify(outbox)).not.toContain("m8-test-private-key-must-not-leak");
  }, 30_000);

  it("authenticates the exact raw body and rolls back before-outbox faults", async () => {
    const opened = loadGithubWebhookFixture("pull-request-opened.json", ids, { oldSha });
    const invalidBody = Buffer.from(`${opened.toString("utf8")}\n`);
    const invalid = await fetch(`${apiOrigin}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "m8-api-invalid-raw-body-v1",
        "x-hub-signature-256": githubSignature(opened, webhookSecret),
      },
      body: invalidBody.toString("utf8"),
    });
    expect(invalid.status).toBe(401);
    expect(
      await prisma.webhookDelivery.count({ where: { deliveryId: "m8-api-invalid-raw-body-v1" } }),
    ).toBe(0);

    const failedDeliveryId = "m8-api-before-outbox-failure-v1";
    const failedEvent = {
      deliveryId: failedDeliveryId,
      eventName: "pull_request" as const,
      payloadSha256: "d".repeat(64),
      event: {
        action: "synchronize" as const,
        installationId: ids.installationId,
        repositoryId: ids.repositoryId,
        repositoryFullName: ids.repositoryFullName,
        pullRequestId: ids.pullRequestId,
        pullRequestNumber: 8,
        commitSha: failedSha,
        sourceTimestamp: "2026-09-17T08:03:00.000Z",
      },
    };
    await expect(
      new WebhookRepository(prisma, {
        faultInjector: (stage) => {
          if (stage === "before-outbox") throw new Error("m8 injected before-outbox rollback");
        },
      }).process(failedEvent),
    ).rejects.toThrow("m8 injected before-outbox rollback");
    expect(await prisma.webhookDelivery.count({ where: { deliveryId: failedDeliveryId } })).toBe(0);
    expect(await prisma.deployment.count({ where: { id: { in: deploymentIds } } })).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: { in: deploymentIds } } })).toBe(
      2,
    );
    const environment = await prisma.previewEnvironment.findFirstOrThrow({ where: { projectId } });
    expect(environment.desiredCommitSha).toBe(newSha);
    expect(environmentId).toBe(environment.id);
  }, 30_000);

  async function postWebhook(rawBody: Buffer, deliveryId: string) {
    const response = await fetch(`${apiOrigin}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": githubSignature(rawBody, webhookSecret),
      },
      body: rawBody.toString("utf8"),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { response, body };
  }
});

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${label}`);
  return value;
}
