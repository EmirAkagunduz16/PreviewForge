import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createPrismaClient,
  DeploymentRepository,
  type PrismaClient,
} from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BuildKitAdapter,
  type BuildKitBuildInput,
  BuildKitInfrastructureError,
} from "./build/buildkit-adapter.js";
import { runDeploymentBuildPipeline } from "./build/deployment-build-pipeline.js";
import { materializeSourceContext } from "./build/source-context.js";
import { GitHubSourceClient } from "./source/github-source.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const buildkitAddress = process.env.BUILDKIT_ADDR;
const registryHost = process.env.REGISTRY_URL;
const registryProtocol = process.env.REGISTRY_PROTOCOL ?? "http";

if (!databaseUrl) throw new Error("DATABASE_URL is required for M4 integration tests");
if (!buildkitAddress) throw new Error("BUILDKIT_ADDR is required for M4 integration tests");
if (!registryHost) throw new Error("REGISTRY_URL is required for M4 integration tests");
const configuredBuildkitAddress = buildkitAddress;
const configuredRegistryHost = registryHost;
let archiveRoot: string | undefined;

type Fixture = {
  userId: string;
  environmentId: string;
  deploymentId: string;
  commitSha: string;
  repositoryFullName: string;
  githubInstallationId: string;
};

type SourceMode = "PRIVATE" | "PUBLIC" | "UNAUTHORIZED" | "UPSTREAM";

type BuildOverrides = {
  sourceMode?: SourceMode;
  buildkit?: Pick<BuildKitAdapter, "buildAndPush">;
  claim?: boolean;
};

describe("M4 source, rootless BuildKit, registry, and desired-SHA boundary", () => {
  let prisma: PrismaClient;
  let server: Server;
  let apiBaseUrl: string;
  let archiveBytes: Uint8Array;
  let sourceMode: SourceMode = "PRIVATE";
  const fixtures: Fixture[] = [];
  const pushed: Array<{ repository: string; digest: string }> = [];
  const authorizationHeaders: string[] = [];
  const buildInputs: BuildKitBuildInput[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    archiveBytes = await createArchive();
    server = createServer((request, response) => {
      const authorization = request.headers.authorization;
      if (authorization !== undefined) authorizationHeaders.push(authorization);
      if (sourceMode === "UNAUTHORIZED") {
        response.writeHead(401);
        response.end();
        return;
      }
      if (sourceMode === "UPSTREAM") {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": archiveBytes.byteLength,
      });
      response.end(archiveBytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("M4 fixture server did not bind");
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await Promise.all(
      pushed.map(({ repository, digest }) =>
        fetch(
          `${registryProtocol}://${configuredRegistryHost}/v2/${repository}/manifests/${encodeURIComponent(digest)}`,
          { method: "DELETE" },
        ).catch(() => undefined),
      ),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(
      fixtures.map(async (fixture) => {
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: fixture.deploymentId } });
        await prisma.user.delete({ where: { id: fixture.userId } });
      }),
    );
    await prisma.$disconnect();
    if (archiveRoot !== undefined) await rm(archiveRoot, { recursive: true, force: true });
  });

  it("fetches a private archive, builds rootlessly, and persists the verified digest", async () => {
    const fixture = await createFixture(prisma, "a".repeat(40));
    fixtures.push(fixture);
    const result = await runBuild(fixture);

    expect(result.kind).toBe("DEPLOYING");
    if (result.kind !== "DEPLOYING") return;
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "DEPLOYING",
      imageDigest: result.digest,
    });
    expect(authorizationHeaders).toContain("Bearer installation-secret");
  }, 240_000);

  it("durably supersedes a pushed image when the desired SHA changes before publication", async () => {
    const fixture = await createFixture(prisma, "b".repeat(40));
    fixtures.push(fixture);
    const replacementSha = "c".repeat(40);
    const result = await runBuild(fixture, replacementSha);

    expect(result).toEqual({ kind: "SUPERSEDED" });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "SUPERSEDED",
      imageDigest: null,
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } })).toBe(
      4,
    );
  }, 240_000);

  it("builds a public fixture without crossing credentials into the build boundary", async () => {
    const fixture = await createFixture(prisma, "d".repeat(40));
    fixtures.push(fixture);
    const result = await runBuild(fixture, undefined, { sourceMode: "PUBLIC" });

    expect(result.kind).toBe("DEPLOYING");
    const buildInput = buildInputs.at(-1);
    expect(buildInput).toBeDefined();
    expect(buildInput).not.toHaveProperty("token");
    expect(JSON.stringify(buildInput)).not.toContain("installation-secret");
  }, 240_000);

  it("records unauthorized source access as a durable non-retryable failure", async () => {
    const fixture = await createFixture(prisma, "e".repeat(40));
    fixtures.push(fixture);
    const result = await runBuild(fixture, undefined, { sourceMode: "UNAUTHORIZED" });

    expect(result).toEqual({ kind: "FAILED", stage: "SOURCE", code: "SOURCE_UNAUTHORIZED" });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "FAILED",
      failureStage: "SOURCE",
      failureCode: "SOURCE_UNAUTHORIZED",
      failureRetryable: false,
    });
  }, 240_000);

  it("records a BuildKit timeout as a retryable durable failure", async () => {
    const fixture = await createFixture(prisma, "f".repeat(40));
    fixtures.push(fixture);
    const result = await runBuild(fixture, undefined, {
      buildkit: {
        buildAndPush: async () => {
          throw new BuildKitInfrastructureError("BUILDKIT_TIMEOUT", true);
        },
      },
    });

    expect(result).toEqual({ kind: "FAILED", stage: "PUSHING", code: "BUILDKIT_TIMEOUT" });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "FAILED",
      failureStage: "PUSHING",
      failureCode: "BUILDKIT_TIMEOUT",
      failureRetryable: true,
    });
  }, 240_000);

  async function runBuild(
    fixture: Fixture,
    replacementSha?: string,
    overrides: BuildOverrides = {},
  ) {
    sourceMode = overrides.sourceMode ?? "PRIVATE";
    const deployments = new DeploymentRepository(prisma);
    if (overrides.claim !== false) {
      await expect(
        deployments.transition({
          deploymentId: fixture.deploymentId,
          expectedStatus: "QUEUED",
          to: "CLONING",
          expectedDesiredSha: fixture.commitSha,
        }),
      ).resolves.toMatchObject({ applied: true });
    }

    const sourceClient = new GitHubSourceClient({
      apiBaseUrl,
      tokenProvider: async () => "installation-secret",
    });
    const adapter = new BuildKitAdapter({ address: configuredBuildkitAddress, timeoutMs: 120_000 });
    const contextRoot = await mkdtemp(join(tmpdir(), "previewforge-m4-context-root-"));
    const buildkit = {
      buildAndPush: async (input: Parameters<BuildKitAdapter["buildAndPush"]>[0]) => {
        buildInputs.push(input);
        const result = await (overrides.buildkit ?? adapter).buildAndPush(input);
        if (overrides.buildkit === undefined) {
          pushed.push({ repository: imageRepository(fixture), digest: result.digest });
        }
        if (replacementSha !== undefined) {
          await prisma.previewEnvironment.update({
            where: { id: fixture.environmentId },
            data: { desiredCommitSha: replacementSha },
          });
        }
        return result;
      },
    };

    try {
      return await runDeploymentBuildPipeline(
        {
          deploymentId: fixture.deploymentId,
          desiredSha: fixture.commitSha,
          source: {
            installationId: fixture.githubInstallationId,
            repositoryFullName: fixture.repositoryFullName,
            commitSha: fixture.commitSha,
            dockerfilePath: "Dockerfile",
          },
          imageReference: `${configuredRegistryHost}/${imageRepository(fixture)}:m4-${fixture.commitSha}`,
        },
        {
          sourceClient,
          buildkit,
          deployments,
          materialize: (archive) => materializeSourceContext(archive, { tempRoot: contextRoot }),
        },
      );
    } finally {
      await rm(contextRoot, { recursive: true, force: true });
      sourceMode = "PRIVATE";
    }
  }

  async function createFixture(client: PrismaClient, commitSha: string): Promise<Fixture> {
    const suffix = randomUUID();
    const userId = randomUUID();
    const installationId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    const deploymentId = randomUUID();
    const githubInstallationId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    const repositoryFullName = `m4-integration/${suffix}`;
    await client.user.create({
      data: { id: userId, githubUserId: `m4-${suffix}`, githubLogin: `m4-${suffix}` },
    });
    await client.installation.create({
      data: {
        id: installationId,
        githubInstallationId: BigInt(githubInstallationId),
        accountLogin: `m4-${suffix}`,
        accountType: "User",
        ownerId: userId,
      },
    });
    await client.project.create({
      data: {
        id: projectId,
        installationId,
        ownerId: userId,
        githubRepositoryId: BigInt(`${Date.now()}${Math.floor(Math.random() * 100_000)}`),
        repositoryFullName,
      },
    });
    await client.previewEnvironment.create({
      data: {
        id: environmentId,
        projectId,
        previewKey: `m4-${suffix}`,
        desiredCommitSha: commitSha,
      },
    });
    await client.deployment.create({ data: { id: deploymentId, environmentId, commitSha } });
    return {
      userId,
      environmentId,
      deploymentId,
      commitSha,
      repositoryFullName,
      githubInstallationId,
    };
  }
});

function imageRepository(fixture: Fixture): string {
  return `previewforge-m4/${fixture.deploymentId}`;
}

async function createArchive(): Promise<Uint8Array> {
  archiveRoot = await mkdtemp(join(tmpdir(), "previewforge-m4-archive-"));
  const sourceRoot = join(archiveRoot, "repository-root");
  await mkdir(sourceRoot);
  await writeFile(
    join(sourceRoot, "Dockerfile"),
    ["FROM scratch", "COPY message.txt /message.txt", ""].join("\n"),
  );
  await writeFile(join(sourceRoot, "message.txt"), "private fixture content\n");
  const archivePath = join(archiveRoot, "source.tar.gz");
  await execFileAsync("tar", [
    "--create",
    "--gzip",
    "--file",
    archivePath,
    "--directory",
    archiveRoot,
    "repository-root",
  ]);
  return new Uint8Array(await readFile(archivePath));
}
