import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, LogChunkRepository, type PrismaClient } from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuildKitAdapter } from "./buildkit-adapter.js";

const buildkitAddress = process.env.BUILDKIT_ADDR;
const registryHost = process.env.REGISTRY_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!buildkitAddress) throw new Error("BUILDKIT_ADDR is required for BuildKit integration tests");
if (!registryHost) throw new Error("REGISTRY_URL is required for BuildKit integration tests");
if (!databaseUrl) throw new Error("DATABASE_URL is required for BuildKit log integration tests");

const runId = randomUUID();
const repository = `previewforge/m4-${runId}`;
const imageReference = `${registryHost.replace(/\/$/u, "")}/${repository}:acceptance`;
const registryProtocol = process.env.REGISTRY_PROTOCOL ?? "http";

describe("rootless BuildKit and registry", () => {
  let contextPath: string;
  let digest: string;
  let prisma: PrismaClient;
  let fixtureUserId: string;
  let deploymentId: string;
  const buildCommit = "e".repeat(40);

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    fixtureUserId = randomUUID();
    const installationId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    await prisma.user.create({
      data: {
        id: fixtureUserId,
        githubUserId: `buildkit-log-${runId}`,
        githubLogin: `buildkit-log-${runId}`,
      },
    });
    await prisma.installation.create({
      data: {
        id: installationId,
        githubInstallationId: BigInt(Date.now()),
        accountLogin: `buildkit-log-${runId}`,
        accountType: "User",
        ownerId: fixtureUserId,
      },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        installationId,
        ownerId: fixtureUserId,
        repositoryFullName: `integration/buildkit-log-${runId}`,
      },
    });
    await prisma.previewEnvironment.create({
      data: {
        id: environmentId,
        projectId,
        previewKey: `buildkit-log-${runId}`,
        desiredCommitSha: buildCommit,
      },
    });
    const deployment = await prisma.deployment.create({
      data: { environmentId, commitSha: buildCommit },
    });
    deploymentId = deployment.id;
    contextPath = await mkdtemp(join(tmpdir(), "previewforge-m4-build-"));
    await writeFile(join(contextPath, "message.txt"), "M4 acceptance\n");
    await writeFile(
      join(contextPath, "Dockerfile"),
      ["FROM scratch", "COPY message.txt /message.txt", ""].join("\n"),
    );
  });

  afterAll(async () => {
    if (digest !== undefined) {
      await fetch(
        `${registryProtocol}://${registryHost}/v2/${repository}/manifests/${encodeURIComponent(digest)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    if (contextPath !== undefined) await rm(contextPath, { recursive: true, force: true });
    if (fixtureUserId !== undefined) await prisma.user.delete({ where: { id: fixtureUserId } });
    await prisma?.$disconnect();
  });

  it("builds, pushes, and verifies the immutable registry digest", async () => {
    const logs = new LogChunkRepository(prisma);
    const oldSentinel = process.env.PREVIEWFORGE_TEST_SECRET_SENTINEL;
    const sentinel = `private-${randomUUID()}`;
    process.env.PREVIEWFORGE_TEST_SECRET_SENTINEL = sentinel;
    let result: Awaited<ReturnType<BuildKitAdapter["buildAndPush"]>>;
    try {
      result = await new BuildKitAdapter({
        address: buildkitAddress,
        timeoutMs: 120_000,
      }).buildAndPush({
        contextPath,
        dockerfilePath: "Dockerfile",
        imageReference,
        onOutput: ({ stream, text }) =>
          logs
            .append({
              deploymentId,
              desiredSha: buildCommit,
              stage: "PUSHING",
              stream,
              text,
            })
            .then(() => undefined),
      });
    } finally {
      if (oldSentinel === undefined) delete process.env.PREVIEWFORGE_TEST_SECRET_SENTINEL;
      else process.env.PREVIEWFORGE_TEST_SECRET_SENTINEL = oldSentinel;
    }
    digest = result.digest;
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const response = await fetch(
      `${registryProtocol}://${registryHost}/v2/${repository}/manifests/${encodeURIComponent(result.digest)}`,
      {
        headers: {
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("docker-content-digest")).toBe(result.digest);
    const persisted = await new LogChunkRepository(prisma).readPage(fixtureUserId, deploymentId, {
      after: 0,
      limit: 1_000,
    });
    expect(persisted.kind).toBe("found");
    if (persisted.kind !== "found") throw new Error("Build log deployment disappeared");
    expect(persisted.chunks.length).toBeGreaterThan(0);
    expect(persisted.chunks.map((chunk) => chunk.sequence)).toEqual(
      Array.from({ length: persisted.chunks.length }, (_, index) => index + 1),
    );
    const persistedText = persisted.chunks.map((chunk) => chunk.text).join("");
    expect(persistedText.length).toBeGreaterThan(0);
    expect(persistedText).not.toContain(sentinel);
  }, 180_000);
});
