import type { Prisma, PrismaClient } from "@prisma/client";

export const LOG_CHUNK_MAX_UTF8_BYTES = 16_384;
export const LOG_DEPLOYMENT_MAX_UTF8_BYTES = 2_097_152;
export const LOG_RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const LOG_MAX_SEQUENCE = 2_147_483_647;
const LOG_APPEND_MAX_UTF8_BYTES = 2_097_152;
const LOG_MAX_PAGE_SIZE = 1_000;
const LOG_STAGE_VALUES = new Set(["CLONING", "BUILDING", "PUSHING"]);
const LOG_STREAM_VALUES = new Set(["stdout", "stderr"]);

export type LogChunkInput = {
  deploymentId: string;
  desiredSha: string;
  stage: string;
  stream: string;
  text: string;
};

export type LogChunkPageOptions = {
  after: number;
  limit: number;
};

export type LogChunkPage = {
  kind: "found";
  chunks: Array<{
    sequence: number;
    stage: string;
    stream: string;
    text: string;
    createdAt: Date;
  }>;
  gap: null | { resumeSequence: number };
  nextSequence: number;
  hasMore: boolean;
};

export class LogChunkValidationError extends Error {
  constructor() {
    super("Invalid durable log input");
    this.name = "LogChunkValidationError";
  }
}

export class LogChunkDeploymentRejectedError extends Error {
  constructor(readonly reason: "MISSING" | "STALE") {
    super(
      reason === "MISSING" ? "Log deployment not found" : "Log deployment is no longer desired",
    );
    this.name = "LogChunkDeploymentRejectedError";
  }
}

export class LogChunkSequenceExhaustedError extends Error {
  constructor() {
    super("Deployment log sequence exhausted");
    this.name = "LogChunkSequenceExhaustedError";
  }
}

/** PostgreSQL-backed, deployment-ordered, bounded durable log storage. */
export class LogChunkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(
    input: LogChunkInput,
  ): Promise<{ firstSequence: number; nextSequence: number } | null> {
    validateInput(input);
    const chunks = splitUtf8(stripTerminalControls(input.text), LOG_CHUNK_MAX_UTF8_BYTES);
    if (chunks.length === 0) return null;
    if (Buffer.byteLength(input.text, "utf8") > LOG_APPEND_MAX_UTF8_BYTES) {
      throw new LogChunkValidationError();
    }

    return this.prisma.$transaction(async (tx) => {
      const matches = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT d."id"
        FROM "deployments" AS d
        JOIN "preview_environments" AS e ON e."id" = d."environment_id"
        WHERE d."id" = ${input.deploymentId}::uuid
          AND d."commit_sha" = ${input.desiredSha}
          AND e."desired_commit_sha" = ${input.desiredSha}
        FOR UPDATE OF d, e
      `;
      if (matches.length === 0) {
        const exists = await tx.deployment.count({ where: { id: input.deploymentId } });
        throw new LogChunkDeploymentRejectedError(exists === 0 ? "MISSING" : "STALE");
      }

      const deployment = await tx.deployment.findUniqueOrThrow({
        where: { id: input.deploymentId },
        select: { logSequenceHighWatermark: true },
      });
      const first = deployment.logSequenceHighWatermark;
      const after = first + BigInt(chunks.length);
      if (first < 1n || first > BigInt(LOG_MAX_SEQUENCE) || after > BigInt(LOG_MAX_SEQUENCE) + 1n) {
        throw new LogChunkSequenceExhaustedError();
      }

      const sequenceStart = Number(first);
      await tx.logChunk.createMany({
        data: chunks.map((text, index) => ({
          deploymentId: input.deploymentId,
          sequence: sequenceStart + index,
          stage: input.stage,
          stream: input.stream,
          text,
        })),
      });
      await tx.deployment.update({
        where: { id: input.deploymentId },
        data: { logSequenceHighWatermark: after },
      });
      await prune(tx, input.deploymentId);
      return { firstSequence: sequenceStart, nextSequence: Number(after) };
    });
  }

  async readPage(
    ownerId: string,
    deploymentId: string,
    options: LogChunkPageOptions,
  ): Promise<LogChunkPage | { kind: "missing" }> {
    validatePageOptions(ownerId, deploymentId, options);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT d."id"
        FROM "deployments" AS d
        JOIN "preview_environments" AS e ON e."id" = d."environment_id"
        JOIN "projects" AS p ON p."id" = e."project_id"
        WHERE d."id" = ${deploymentId}::uuid AND p."owner_id" = ${ownerId}::uuid
        FOR UPDATE OF d
      `;
      if (locked.length === 0) return { kind: "missing" as const };
      await prune(tx, deploymentId);
      const deployment = await tx.deployment.findUniqueOrThrow({
        where: { id: deploymentId },
        select: { logSequenceHighWatermark: true },
      });
      const nextSequence = Number(deployment.logSequenceHighWatermark);
      const lastAllocated = nextSequence - 1;
      if (options.after > lastAllocated) throw new LogChunkValidationError();
      const oldest = await tx.logChunk.findFirst({
        where: { deploymentId },
        orderBy: { sequence: "asc" },
        select: { sequence: true },
      });
      const gapResumeSequence = oldest
        ? options.after < oldest.sequence - 1
          ? oldest.sequence
          : null
        : options.after < lastAllocated
          ? nextSequence
          : null;
      const chunks = await tx.logChunk.findMany({
        where: { deploymentId, sequence: { gt: options.after } },
        orderBy: { sequence: "asc" },
        take: options.limit + 1,
        select: { sequence: true, stage: true, stream: true, text: true, createdAt: true },
      });
      const hasMore = chunks.length > options.limit;
      return {
        kind: "found" as const,
        chunks: chunks.slice(0, options.limit),
        gap: gapResumeSequence === null ? null : { resumeSequence: gapResumeSequence },
        nextSequence,
        hasMore,
      };
    });
  }
}

async function prune(tx: Prisma.TransactionClient, deploymentId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "log_chunks"
    WHERE "deployment_id" = ${deploymentId}::uuid
      AND "created_at" < CURRENT_TIMESTAMP - INTERVAL '30 days'
  `;
  await tx.$executeRaw`
    WITH newest_first AS (
      SELECT "sequence",
        SUM(octet_length("text")) OVER (ORDER BY "sequence" DESC ROWS UNBOUNDED PRECEDING) AS retained_bytes
      FROM "log_chunks"
      WHERE "deployment_id" = ${deploymentId}::uuid
    ), evicted AS (
      SELECT "sequence" FROM newest_first WHERE retained_bytes > ${LOG_DEPLOYMENT_MAX_UTF8_BYTES}
    )
    DELETE FROM "log_chunks"
    WHERE "deployment_id" = ${deploymentId}::uuid
      AND "sequence" IN (SELECT "sequence" FROM evicted)
  `;
}

function validateInput(input: LogChunkInput): void {
  if (
    !isUuid(input.deploymentId) ||
    !/^[a-f0-9]{40}$/iu.test(input.desiredSha) ||
    !LOG_STAGE_VALUES.has(input.stage) ||
    !LOG_STREAM_VALUES.has(input.stream) ||
    typeof input.text !== "string" ||
    input.text.includes("\u0000") ||
    hasUnpairedSurrogate(input.text) ||
    Buffer.byteLength(input.text, "utf8") > LOG_APPEND_MAX_UTF8_BYTES
  ) {
    throw new LogChunkValidationError();
  }
}

function validatePageOptions(
  ownerId: string,
  deploymentId: string,
  options: LogChunkPageOptions,
): void {
  if (
    !isUuid(ownerId) ||
    !isUuid(deploymentId) ||
    !Number.isSafeInteger(options.after) ||
    options.after < 0 ||
    options.after > LOG_MAX_SEQUENCE ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > LOG_MAX_PAGE_SIZE
  ) {
    throw new LogChunkValidationError();
  }
}

function splitUtf8(input: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const codePoint of input) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (chunkBytes > 0 && chunkBytes + bytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += codePoint;
    chunkBytes += bytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function stripTerminalControls(value: string): string {
  const codePoints = Array.from(value);
  const plain: string[] = [];
  for (let index = 0; index < codePoints.length; index += 1) {
    const code = codePoints[index]?.codePointAt(0) ?? 0;
    if (code === 27) {
      const next = codePoints[index + 1];
      if (next === "[") {
        index += 2;
        while (index < codePoints.length) {
          const current = codePoints[index]?.codePointAt(0) ?? 0;
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
      } else if (next === "]") {
        index += 2;
        while (index < codePoints.length) {
          if (codePoints[index] === "\u0007") break;
          if (codePoints[index] === "\u001b" && codePoints[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
      } else if (next !== undefined) index += 1;
      continue;
    }
    if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f) continue;
    plain.push(codePoints[index] ?? "");
  }
  return plain.join("");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
