import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

const DEFAULT_CLAIM_LIMIT = 50;
const MAX_CLAIM_LIMIT = 100;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_LEASE_DURATION_MS = 86_400_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 86_400_000;
const MAX_ERROR_LENGTH = 2_000;

export type OutboxClaimOptions = {
  owner: string;
  limit?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
};

export type OutboxRelayRecord = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.JsonValue;
  traceParent: string | null;
  attempts: number;
  availableAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
  claimToken: string | null;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  lastAttemptAt: Date | null;
  deadLetteredAt: Date | null;
  deadLetterReason: string | null;
  createdAt: Date;
};

export type OutboxFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type RecordFailureOptions = {
  id: string;
  claimToken: string;
  failure: OutboxFailure;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export type OutboxFailureResult = {
  outcome: "RETRY_SCHEDULED" | "DEAD_LETTER";
  outbox: OutboxRelayRecord;
};

export type MarkPublishedResult = {
  outcome: "PUBLISHED" | "ALREADY_PUBLISHED";
  outbox: OutboxRelayRecord;
};

export class OutboxRelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxRelayValidationError";
  }
}

export class OutboxClaimLostError extends Error {
  readonly code = "OUTBOX_CLAIM_LOST";

  constructor() {
    super("outbox claim is missing, expired, or owned by another relay");
    this.name = "OutboxClaimLostError";
  }
}

export class OutboxEventNotFoundError extends Error {
  readonly code = "OUTBOX_EVENT_NOT_FOUND";

  constructor() {
    super("outbox event was not found");
    this.name = "OutboxEventNotFoundError";
  }
}

type TransactionClient = Prisma.TransactionClient;

type OutboxRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Prisma.JsonValue;
  trace_parent: string | null;
  attempts: number;
  available_at: Date;
  published_at: Date | null;
  last_error: string | null;
  claim_token: string | null;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  last_attempt_at: Date | null;
  dead_lettered_at: Date | null;
  dead_letter_reason: string | null;
  created_at: Date;
};

/** PostgreSQL-backed, token-fenced outbox relay operations. */
export class OutboxRelayRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claimBatch(options: OutboxClaimOptions): Promise<OutboxRelayRecord[]> {
    const owner = validateOwner(options.owner);
    const limit = validatePositiveInteger(
      options.limit ?? DEFAULT_CLAIM_LIMIT,
      "claim limit",
      MAX_CLAIM_LIMIT,
    );
    const leaseDurationMs = validatePositiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "lease duration",
      MAX_LEASE_DURATION_MS,
    );
    const maxAttempts = validatePositiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maximum attempts",
      100,
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`
          UPDATE "outbox_events"
          SET "dead_lettered_at" = CURRENT_TIMESTAMP,
              "dead_letter_reason" = 'MAX_ATTEMPTS_EXHAUSTED',
              "claim_token" = NULL,
              "claim_owner" = NULL,
              "claim_expires_at" = NULL
          WHERE "published_at" IS NULL
            AND "dead_lettered_at" IS NULL
            AND "available_at" <= CURRENT_TIMESTAMP
            AND "attempts" >= ${maxAttempts}
            AND ("claim_expires_at" IS NULL OR "claim_expires_at" <= CURRENT_TIMESTAMP)
        `,
      );
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "outbox_events"
          WHERE "published_at" IS NULL
            AND "dead_lettered_at" IS NULL
            AND "available_at" <= CURRENT_TIMESTAMP
            AND "attempts" < ${maxAttempts}
            AND ("claim_expires_at" IS NULL OR "claim_expires_at" <= CURRENT_TIMESTAMP)
          ORDER BY "created_at" ASC, "id" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `,
      );

      const claimed: OutboxRelayRecord[] = [];
      for (const candidate of candidates) {
        const claimToken = randomUUID();
        const rows = await tx.$queryRaw<OutboxRow[]>(
          Prisma.sql`
            UPDATE "outbox_events"
            SET "attempts" = "attempts" + 1,
                "last_attempt_at" = CURRENT_TIMESTAMP,
                "claim_token" = ${claimToken}::uuid,
                "claim_owner" = ${owner},
                "claim_expires_at" = CURRENT_TIMESTAMP + (${leaseDurationMs} * INTERVAL '1 millisecond')
            WHERE "id" = ${candidate.id}::uuid
              AND "published_at" IS NULL
              AND "dead_lettered_at" IS NULL
              AND "available_at" <= CURRENT_TIMESTAMP
              AND "attempts" < ${maxAttempts}
              AND ("claim_expires_at" IS NULL OR "claim_expires_at" <= CURRENT_TIMESTAMP)
            RETURNING *
          `,
        );
        const row = rows[0];
        if (row) claimed.push(toClaimedRecord(row));
      }
      return claimed;
    });
  }

  async markPublished(id: string, claimToken: string): Promise<MarkPublishedResult> {
    validateUuid(id, "outbox event ID");
    validateUuid(claimToken, "outbox claim token");

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>(
        Prisma.sql`
          UPDATE "outbox_events"
          SET "published_at" = CURRENT_TIMESTAMP,
              "claim_token" = NULL,
              "claim_owner" = NULL,
              "claim_expires_at" = NULL
          WHERE "id" = ${id}::uuid
            AND "claim_token" = ${claimToken}::uuid
            AND "claim_expires_at" > CURRENT_TIMESTAMP
            AND "published_at" IS NULL
            AND "dead_lettered_at" IS NULL
          RETURNING *
        `,
      );
      const row = rows[0];
      if (row) {
        return { outcome: "PUBLISHED", outbox: toClaimedRecord(row) };
      }

      const current = await readOutbox(tx, id);
      if (!current) throw new OutboxEventNotFoundError();
      if (current.published_at !== null) {
        return { outcome: "ALREADY_PUBLISHED", outbox: toClaimedRecord(current) };
      }
      throw new OutboxClaimLostError();
    });
  }

  async recordFailure(options: RecordFailureOptions): Promise<OutboxFailureResult> {
    validateUuid(options.id, "outbox event ID");
    validateUuid(options.claimToken, "outbox claim token");
    const failure = validateFailure(options.failure);
    const maxAttempts = validatePositiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maximum attempts",
      100,
    );
    const retryDelayMs = validatePositiveInteger(
      options.retryDelayMs ?? 1_000,
      "retry delay",
      MAX_BACKOFF_MS,
    );
    const safeMessage = redactError(failure.message);
    const safeReason = `${failure.code}: ${safeMessage}`.slice(0, MAX_ERROR_LENGTH);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>(
        Prisma.sql`
          UPDATE "outbox_events"
          SET "last_error" = ${safeMessage},
              "available_at" = CASE
                WHEN ${failure.retryable} AND "attempts" < ${maxAttempts}
                  THEN CURRENT_TIMESTAMP + (${retryDelayMs} * INTERVAL '1 millisecond')
                ELSE CURRENT_TIMESTAMP
              END,
              "dead_lettered_at" = CASE
                WHEN ${failure.retryable} AND "attempts" < ${maxAttempts}
                  THEN NULL
                ELSE CURRENT_TIMESTAMP
              END,
              "dead_letter_reason" = CASE
                WHEN ${failure.retryable} AND "attempts" < ${maxAttempts}
                  THEN NULL
                ELSE ${safeReason}
              END,
              "claim_token" = NULL,
              "claim_owner" = NULL,
              "claim_expires_at" = NULL
          WHERE "id" = ${options.id}::uuid
            AND "claim_token" = ${options.claimToken}::uuid
            AND "claim_expires_at" > CURRENT_TIMESTAMP
            AND "published_at" IS NULL
            AND "dead_lettered_at" IS NULL
          RETURNING *
        `,
      );
      const row = rows[0];
      if (!row) {
        const current = await readOutbox(tx, options.id);
        if (!current) throw new OutboxEventNotFoundError();
        throw new OutboxClaimLostError();
      }

      const outcome = row.dead_lettered_at === null ? "RETRY_SCHEDULED" : "DEAD_LETTER";
      return { outcome, outbox: toClaimedRecord(row) };
    });
  }
}

async function readOutbox(tx: TransactionClient, id: string): Promise<OutboxRow | null> {
  const rows = await tx.$queryRaw<OutboxRow[]>(
    Prisma.sql`SELECT * FROM "outbox_events" WHERE "id" = ${id}::uuid`,
  );
  return rows[0] ?? null;
}

function toClaimedRecord(row: OutboxRow): OutboxRelayRecord {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    traceParent: row.trace_parent,
    attempts: row.attempts,
    availableAt: row.available_at,
    publishedAt: row.published_at,
    lastError: row.last_error,
    claimToken: row.claim_token,
    claimOwner: row.claim_owner,
    claimExpiresAt: row.claim_expires_at,
    lastAttemptAt: row.last_attempt_at,
    deadLetteredAt: row.dead_lettered_at,
    deadLetterReason: row.dead_letter_reason,
    createdAt: row.created_at,
  };
}

function validateOwner(owner: string): string {
  if (typeof owner !== "string" || owner.trim().length === 0 || owner.length > 255) {
    throw new OutboxRelayValidationError("relay owner must be between 1 and 255 characters");
  }
  if (hasControlCharacters(owner)) {
    throw new OutboxRelayValidationError("relay owner contains invalid characters");
  }
  return owner.trim();
}

function validatePositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new OutboxRelayValidationError(`${label} is outside the supported range`);
  }
  return value;
}

function validateUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OutboxRelayValidationError(`${label} is invalid`);
  }
}

function validateFailure(failure: OutboxFailure): OutboxFailure {
  if (
    failure === null ||
    typeof failure !== "object" ||
    typeof failure.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,63}$/.test(failure.code) ||
    typeof failure.message !== "string" ||
    failure.message.trim().length === 0 ||
    failure.message.length > MAX_ERROR_LENGTH ||
    typeof failure.retryable !== "boolean"
  ) {
    throw new OutboxRelayValidationError("failure details are invalid");
  }
  return failure;
}

function redactError(message: string): string {
  return message
    .trim()
    .replace(/(ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization\s*:\s*)?(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\btoken\s*[:=]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .replace(/\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[REDACTED]@[REDACTED]")
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .slice(0, MAX_ERROR_LENGTH);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}
