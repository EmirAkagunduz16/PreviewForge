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
import { BuildKitAdapter } from "./build/buildkit-adapter.js";
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

describe("M4 source, rootless BuildKit, registry, and desired-SHA boundary", () => {
  let prisma: PrismaClient;
  let server: Server;
  let apiBaseUrl: string;
  let archiveBytes: Uint8Array;
  const fixtures: Fixture[] = [];
  const pushed: Array<{ repository: string; digest: string }> = [];
  const authorizationHeaders: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    archiveBytes = await createArchive();
    server = createServer((request, response) => {
      const authorization = request.headers.authorization;
      if (authorization !== undefined) authorizationHeaders.push(authorization);
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

  async function runBuild(fixture: Fixture, replacementSha?: string) {
    const deployments = new DeploymentRepository(prisma);
    await expect(
      deployments.transition({
        deploymentId: fixture.deploymentId,
        expectedStatus: "QUEUED",
        to: "CLONING",
        expectedDesiredSha: fixture.commitSha,
      }),
    ).resolves.toMatchObject({ applied: true });

    const sourceClient = new GitHubSourceClient({
      apiBaseUrl,
      tokenProvider: async () => "installation-secret",
    });
    const adapter = new BuildKitAdapter({ address: configuredBuildkitAddress, timeoutMs: 120_000 });
    const contextRoot = await mkdtemp(join(tmpdir(), "previewforge-m4-context-root-"));
    const buildkit = {
      buildAndPush: async (input: Parameters<BuildKitAdapter["buildAndPush"]>[0]) => {
        const result = await adapter.buildAndPush(input);
        pushed.push({ repository: imageRepository(fixture), digest: result.digest });
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
