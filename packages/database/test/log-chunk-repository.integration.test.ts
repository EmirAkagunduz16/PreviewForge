import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  LOG_CHUNK_MAX_UTF8_BYTES,
  LOG_DEPLOYMENT_MAX_UTF8_BYTES,
  LOG_MAX_SEQUENCE,
  LogChunkRepository,
  LogChunkSequenceExhaustedError,
  LogChunkValidationError,
  type PrismaClient,
} from "../src/index.js";
import { createDatabaseFixture } from "./fixtures.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for log chunk integration tests");

describe("LogChunkRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });
  afterAll(async () => {
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("strips terminal controls before UTF-8 chunking and preserves plain text/cursor", async () => {
    const { repository, userId, deploymentId, commitSha } = await createDeployment();
    const plain = `${"x".repeat(LOG_CHUNK_MAX_UTF8_BYTES - 3)}🙂\t雪\nZ`;
    const text = `${"x".repeat(LOG_CHUNK_MAX_UTF8_BYTES - 3)}\u001b[31m🙂\u001b[0m\u001b]0;private-title\u0007\t雪\nZ`;
    await repository.append({
      deploymentId,
      desiredSha: commitSha,
      stage: "BUILDING",
      stream: "stdout",
      text,
    });
    const restarted = new LogChunkRepository(prisma);
    const page = await restarted.readPage(userId, deploymentId, { after: 0, limit: 10 });
    expect(page.kind).toBe("found");
    if (page.kind !== "found") throw new Error("deployment unexpectedly missing");
    expect(page.chunks.map((chunk) => Buffer.byteLength(chunk.text, "utf8"))).toEqual([
      LOG_CHUNK_MAX_UTF8_BYTES - 3,
      10,
    ]);
    expect(page.chunks.map((chunk) => chunk.text).join("")).toBe(plain);
    expect(page.chunks.map((chunk) => chunk.text).join("")).not.toContain("private-title");
    expect(page.chunks.map((chunk) => chunk.text).join("")).not.toContain("\u001b");
    expect(page.chunks.every((chunk) => chunk.createdAt instanceof Date)).toBe(true);
    await expect(
      repository.append({
        deploymentId,
        desiredSha: commitSha,
        stage: "BUILDING",
        stream: "stdout",
        text: "bad\u0000text",
      }),
    ).rejects.toBeInstanceOf(LogChunkValidationError);
  });

  it("evicts the oldest sequence at the exact deployment byte cap", async () => {
    const { repository, userId, deploymentId, commitSha } = await createDeployment();
    const full = "a".repeat(LOG_DEPLOYMENT_MAX_UTF8_BYTES);
    await repository.append({
      deploymentId,
      desiredSha: commitSha,
      stage: "BUILDING",
      stream: "stdout",
      text: full,
    });
    await repository.append({
      deploymentId,
      desiredSha: commitSha,
      stage: "BUILDING",
      stream: "stderr",
      text: "b",
    });
    const page = await repository.readPage(userId, deploymentId, { after: 0, limit: 200 });
    expect(page.kind).toBe("found");
    if (page.kind !== "found") throw new Error("deployment unexpectedly missing");
    expect(page.gap).toEqual({ resumeSequence: 2 });
    expect(page.chunks.map((chunk) => chunk.sequence)).toEqual(
      Array.from(
        { length: LOG_DEPLOYMENT_MAX_UTF8_BYTES / LOG_CHUNK_MAX_UTF8_BYTES },
        (_, i) => i + 2,
      ),
    );
    const retainedBytes = page.chunks.reduce(
      (sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"),
      0,
    );
    expect(retainedBytes).toBe(LOG_DEPLOYMENT_MAX_UTF8_BYTES - LOG_CHUNK_MAX_UTF8_BYTES + 1);
    expect(await prisma.logChunk.count({ where: { deploymentId } })).toBe(128);
  });

  it("expires strictly by createdAt and preserves the next-sequence gap when every row is gone", async () => {
    const { repository, userId, deploymentId, commitSha } = await createDeployment();
    await repository.append({
      deploymentId,
      desiredSha: commitSha,
      stage: "PUSHING",
      stream: "stdout",
      text: "expired",
    });
    const future = new Date(Date.now() + 60_000);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await prisma.logChunk.updateMany({
      where: { deploymentId },
      data: { createdAt: old, emittedAt: future },
    });
    const page = await new LogChunkRepository(prisma).readPage(userId, deploymentId, {
      after: 0,
      limit: 10,
    });
    expect(page.kind).toBe("found");
    if (page.kind !== "found") throw new Error("deployment unexpectedly missing");
    expect(page.chunks).toEqual([]);
    expect(page.nextSequence).toBe(2);
    expect(page.gap).toEqual({ resumeSequence: 2 });
    expect(await prisma.logChunk.count({ where: { deploymentId } })).toBe(0);
  });

  it("serializes concurrent appends and rejects stale writers without partial rows", async () => {
    const { repository, userId, deploymentId, commitSha, environmentId } = await createDeployment();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repository.append({
          deploymentId,
          desiredSha: commitSha,
          stage: "PUSHING",
          stream: i % 2 ? "stdout" : "stderr",
          text: `entry-${i}\n`,
        }),
      ),
    );
    const page = await new LogChunkRepository(prisma).readPage(userId, deploymentId, {
      after: 0,
      limit: 20,
    });
    expect(page.kind).toBe("found");
    if (page.kind !== "found") throw new Error("deployment unexpectedly missing");
    expect(page.chunks.map((chunk) => chunk.sequence)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(new Set(page.chunks.map((chunk) => chunk.text)).size).toBe(12);

    await prisma.previewEnvironment.update({
      where: { id: environmentId },
      data: { desiredCommitSha: "f".repeat(40) },
    });
    await expect(
      repository.append({
        deploymentId,
        desiredSha: commitSha,
        stage: "PUSHING",
        stream: "stdout",
        text: "stale",
      }),
    ).rejects.toMatchObject({ reason: "STALE" });
    expect(await prisma.logChunk.count({ where: { deploymentId } })).toBe(12);
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } }))
        .logSequenceHighWatermark,
    ).toBe(13n);
  });

  it("rolls back inserted chunks and sequence state when the high-water update fails", async () => {
    const { repository, userId, deploymentId, commitSha } = await createDeployment();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `m6_log_fail_${suffix}`;
    const triggerName = `m6_log_fail_${suffix}`;
    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $m6$
        BEGIN
          IF NEW."id" = '${deploymentId}'::uuid
            AND NEW."log_sequence_high_watermark" > OLD."log_sequence_high_watermark" THEN
            RAISE EXCEPTION 'fixture high-water failure';
          END IF;
          RETURN NEW;
        END;
        $m6$;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        BEFORE UPDATE OF "log_sequence_high_watermark" ON "deployments"
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
      `);
      await expect(
        repository.append({
          deploymentId,
          desiredSha: commitSha,
          stage: "BUILDING",
          stream: "stdout",
          text: "x".repeat(LOG_CHUNK_MAX_UTF8_BYTES + 1),
        }),
      ).rejects.toThrow();
      expect(await prisma.logChunk.count({ where: { deploymentId } })).toBe(0);
      expect(
        (await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } }))
          .logSequenceHighWatermark,
      ).toBe(1n);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "deployments"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
    const appended = await repository.append({
      deploymentId,
      desiredSha: commitSha,
      stage: "BUILDING",
      stream: "stdout",
      text: "recovered",
    });
    expect(appended).toEqual({ firstSequence: 1, nextSequence: 2 });
    expect(await repository.readPage(userId, deploymentId, { after: 0, limit: 10 })).toMatchObject({
      kind: "found",
      chunks: [{ sequence: 1, text: "recovered" }],
    });
  });

  it("fails closed on sequence exhaustion and returns normalized missing deployments", async () => {
    const { repository, userId, deploymentId, commitSha } = await createDeployment();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { logSequenceHighWatermark: BigInt(LOG_MAX_SEQUENCE) + 1n },
    });
    await expect(
      repository.append({
        deploymentId,
        desiredSha: commitSha,
        stage: "BUILDING",
        stream: "stdout",
        text: "no",
      }),
    ).rejects.toBeInstanceOf(LogChunkSequenceExhaustedError);
    expect(await prisma.logChunk.count({ where: { deploymentId } })).toBe(0);
    expect(await repository.readPage(userId, randomUUID(), { after: 0, limit: 10 })).toEqual({
      kind: "missing",
    });
    await expect(
      repository.readPage(userId, deploymentId, { after: 0, limit: 10_001 }),
    ).rejects.toBeInstanceOf(LogChunkValidationError);
    expect(await repository.readPage(randomUUID(), deploymentId, { after: 0, limit: 10 })).toEqual({
      kind: "missing",
    });
    await expect(
      repository.append({
        deploymentId,
        desiredSha: commitSha,
        stage: "DEPLOYING",
        stream: "stdout",
        text: "x",
      }),
    ).rejects.toBeInstanceOf(LogChunkValidationError);
  });

  async function createDeployment() {
    const fixture = await createDatabaseFixture(prisma);
    userIds.push(fixture.userId);
    const deployment = await prisma.deployment.create({
      data: { environmentId: fixture.environmentId, commitSha: fixture.commitSha },
    });
    return {
      repository: new LogChunkRepository(prisma),
      userId: fixture.userId,
      deploymentId: deployment.id,
      commitSha: fixture.commitSha,
      environmentId: fixture.environmentId,
    };
  }
});
