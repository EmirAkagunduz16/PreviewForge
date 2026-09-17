import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  EnvironmentDeletionRepository,
  type PrismaClient,
} from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKubernetesResourceClient } from "../kubernetes/client.js";
import { KubernetesReconciler } from "../kubernetes/reconciler.js";
import { PREVIEW_MANAGED_BY, previewNamespace } from "../kubernetes/resource-renderer.js";
import { reconcileManagedOrphans } from "./orphan-reconciler.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for orphan acceptance");

const orphanEnvironmentId = randomUUID();
const malformedEnvironmentId = randomUUID();
const unownedEnvironmentId = randomUUID();
const wrongOwnerEnvironmentId = randomUUID();
const projectId = randomUUID();
const wrongProjectId = randomUUID();
const userId = randomUUID();
const installationId = randomUUID();
const pullRequestId = randomUUID();
const kubernetes = createKubernetesResourceClient();
const reconciler = new KubernetesReconciler(kubernetes);

describe("M7 orphan reconciliation (kind/PostgreSQL)", () => {
  let prisma: PrismaClient;
  const fixtureNames = [
    previewNamespace(orphanEnvironmentId),
    "pf-malformed-orphan",
    previewNamespace(unownedEnvironmentId),
    previewNamespace(wrongOwnerEnvironmentId),
  ];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    await prisma.user.create({
      data: { id: userId, githubUserId: `m7-orphan-${userId}`, githubLogin: `m7-orphan-${userId}` },
    });
    await prisma.installation.create({
      data: {
        id: installationId,
        githubInstallationId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1_000)}`),
        accountLogin: `m7-orphan-${userId}`,
        accountType: "User",
        ownerId: userId,
      },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        installationId,
        ownerId: userId,
        githubRepositoryId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1_000)}`),
        repositoryFullName: `m7-orphan/${userId}`,
      },
    });
    await prisma.pullRequest.create({
      data: {
        id: pullRequestId,
        projectId,
        number: 1,
        headSha: "a".repeat(40),
        state: "OPEN",
      },
    });
    await prisma.previewEnvironment.create({
      data: {
        id: wrongOwnerEnvironmentId,
        projectId,
        pullRequestId,
        previewKey: `m7-orphan-${wrongOwnerEnvironmentId}`,
        desiredCommitSha: "a".repeat(40),
        status: "ACTIVE",
      },
    });
    await Promise.all([
      applyNamespace(orphanEnvironmentId, projectId),
      applyNamespace(malformedEnvironmentId, projectId, "pf-malformed-orphan"),
      applyNamespace(unownedEnvironmentId, projectId, undefined, false),
      applyNamespace(wrongOwnerEnvironmentId, wrongProjectId),
    ]);
  });

  afterAll(async () => {
    await Promise.allSettled(fixtureNames.map((name) => removeNamespace(name)));
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("deletes the DB-missing orphan and leaves malformed, unowned, and wrong-owner namespaces", async () => {
    const result = await reconcileManagedOrphans({
      kubernetes,
      database: new EnvironmentDeletionRepository(prisma),
      deleteNamespace: (environmentId) => reconciler.deletePreviewNamespace(environmentId),
    });

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ failed: 0, truncated: false });
    await waitForAbsent(previewNamespace(orphanEnvironmentId));
    expect(await kubernetes.get(namespaceIdentity("pf-malformed-orphan"))).not.toBeNull();
    expect(
      await kubernetes.get(namespaceIdentity(previewNamespace(unownedEnvironmentId))),
    ).not.toBeNull();
    expect(
      await kubernetes.get(namespaceIdentity(previewNamespace(wrongOwnerEnvironmentId))),
    ).not.toBeNull();
  }, 60_000);
});

async function applyNamespace(
  environmentId: string,
  projectLabel: string,
  name = previewNamespace(environmentId),
  managed = true,
): Promise<void> {
  await kubernetes.apply({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/name": "preview",
        ...(managed ? { "app.kubernetes.io/managed-by": PREVIEW_MANAGED_BY } : {}),
        ...(managed ? { "previewforge.dev/managed": "true" } : {}),
        "previewforge.dev/project-id": projectLabel,
        "previewforge.dev/environment-id": environmentId,
      },
    },
  });
}

function namespaceIdentity(name: string) {
  return { apiVersion: "v1", kind: "Namespace", name } as const;
}

async function removeNamespace(name: string): Promise<void> {
  const existing = await kubernetes.get(namespaceIdentity(name)).catch(() => null);
  if (existing === null) return;
  await kubernetes.delete?.({
    ...namespaceIdentity(name),
    ...(existing.metadata.uid === undefined ? {} : { uid: existing.metadata.uid }),
    ...(existing.metadata.resourceVersion === undefined
      ? {}
      : { resourceVersion: existing.metadata.resourceVersion }),
  });
}

async function waitForAbsent(name: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await kubernetes.get(namespaceIdentity(name))) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`namespace ${name} was not deleted before timeout`);
}
