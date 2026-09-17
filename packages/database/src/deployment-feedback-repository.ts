import { randomUUID } from "node:crypto";
import { type DeploymentStatus, deploymentStatusSchema } from "@previewforge/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";

const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 100;

export type DeploymentFeedbackContext = {
  deploymentId: string;
  environmentId: string;
  commitSha: string;
  desiredCommitSha: string;
  status: DeploymentStatus;
  failureStage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  failureRetryable: boolean | null;
  checkRunId: string | null;
  imageDigest: string | null;
  repositoryFullName: string;
  installationId: string;
  pullRequestNumber: number | null;
};

export type DeploymentFeedbackLock = {
  context: DeploymentFeedbackContext | null;
  isEventProcessed(eventId: string, consumerName: string): Promise<boolean>;
  markEventProcessed(eventId: string, consumerName: string): Promise<void>;
  storeCheckRunId(checkRunId: string): Promise<void>;
  replaceCheckRunId?(expectedCheckRunId: string, checkRunId: string): Promise<void>;
};

export type FeedbackDeliveryIdentity = {
  consumerName: string;
  topic: string;
  partition: number;
  offset: bigint | number | string;
  payloadDigest: string;
  eventId?: string;
  eventType?: string;
  environmentId?: string;
  aggregateId?: string;
};

export type FeedbackDeliveryClaim =
  | { kind: "CLAIMED"; attempts: number }
  | { kind: "PROCESSED"; attempts: number }
  | { kind: "DEAD_LETTER"; attempts: number }
  | { kind: "RETRY_NOT_DUE"; attempts: number; availableAt: Date };

export type FeedbackDeliveryOutcome = {
  outcome: "RETRY_SCHEDULED" | "DEAD_LETTER";
  attempts: number;
  availableAt: Date;
  deadLetteredAt: Date | null;
};

export type FeedbackDeliveryFailureInput = {
  delivery: FeedbackDeliveryIdentity;
  errorCode: string;
  message: string;
  event?: {
    eventId: string;
    eventType: string;
    environmentId: string;
    aggregateId: string;
  };
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export class DeploymentFeedbackIdentityConflictError extends Error {
  readonly code = "DEPLOYMENT_FEEDBACK_IDENTITY_CONFLICT";

  constructor() {
    super("deployment feedback identity conflicts with durable state");
    this.name = "DeploymentFeedbackIdentityConflictError";
  }
}

export class DeploymentFeedbackDeliveryConflictError extends Error {
  readonly code = "DEPLOYMENT_FEEDBACK_DELIVERY_CONFLICT";

  constructor() {
    super("feedback Kafka delivery identity conflicts with durable metadata");
    this.name = "DeploymentFeedbackDeliveryConflictError";
  }
}

export class DeploymentFeedbackRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly random: () => number = Math.random,
  ) {}

  findByDeploymentId(deploymentId: string): Promise<DeploymentFeedbackContext | null> {
    validateUuid(deploymentId, "deploymentId");
    return readFeedbackContext(this.prisma, deploymentId);
  }

  /**
   * Atomically claims the nullable remote Check Run identity. The compare and
   * set is intentionally separate from remote I/O so tests and recovery paths
   * can prove that only one durable identity wins a concurrent race.
   */
  async claimCheckRunId(input: {
    deploymentId: string;
    checkRunId: string;
  }): Promise<{ claimed: boolean; checkRunId: string | null }> {
    validateUuid(input.deploymentId, "deploymentId");
    validateCheckRunId(input.checkRunId);

    const updated = await this.prisma.deployment.updateMany({
      where: { id: input.deploymentId, checkRunId: null },
      data: { checkRunId: input.checkRunId },
    });
    const current = await this.prisma.deployment.findUnique({
      where: { id: input.deploymentId },
      select: { checkRunId: true },
    });
    if (current === null) return { claimed: false, checkRunId: null };
    if (current.checkRunId !== input.checkRunId) {
      return { claimed: false, checkRunId: current.checkRunId };
    }
    return {
      claimed: updated.count === 1 || current.checkRunId === input.checkRunId,
      checkRunId: current.checkRunId,
    };
  }

  /**
   * Serializes remote Check Run creation per deployment. The transaction stays
   * open across the external call on purpose: a second worker waits, then
   * observes the stored identity. If the first worker crashes after GitHub
   * accepts create but before commit, the caller lists by deterministic
   * external_id while holding this same lock and recovers the remote run.
   */
  withDeploymentLock<T>(
    deploymentId: string,
    callback: (lock: DeploymentFeedbackLock) => Promise<T>,
  ): Promise<T> {
    validateUuid(deploymentId, "deploymentId");
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "deployments" WHERE id = CAST(${deploymentId} AS uuid) FOR UPDATE`;
        const context = await readFeedbackContext(tx, deploymentId);
        return callback({
          context,
          isEventProcessed: async (eventId, consumerName) => {
            validateUuid(eventId, "eventId");
            validateConsumerName(consumerName);
            const receipt = await tx.consumerReceipt.findUnique({
              where: { consumerName_eventId: { consumerName, eventId } },
              select: { id: true },
            });
            return receipt !== null;
          },
          markEventProcessed: async (eventId, consumerName) => {
            validateUuid(eventId, "eventId");
            validateConsumerName(consumerName);
            await tx.consumerReceipt.create({
              data: { id: randomUUID(), consumerName, eventId },
            });
          },
          storeCheckRunId: async (checkRunId) => {
            validateCheckRunId(checkRunId);
            const current = await tx.deployment.findUnique({
              where: { id: deploymentId },
              select: { checkRunId: true },
            });
            if (current === null) return;
            if (current.checkRunId === checkRunId) return;
            if (current.checkRunId !== null) throw new DeploymentFeedbackIdentityConflictError();
            await tx.deployment.update({
              where: { id: deploymentId },
              data: { checkRunId },
            });
          },
          replaceCheckRunId: async (expectedCheckRunId, checkRunId) => {
            validateCheckRunId(expectedCheckRunId);
            validateCheckRunId(checkRunId);
            const current = await tx.deployment.findUnique({
              where: { id: deploymentId },
              select: { checkRunId: true },
            });
            if (current === null || current.checkRunId === checkRunId) return;
            if (current.checkRunId !== expectedCheckRunId) {
              throw new DeploymentFeedbackIdentityConflictError();
            }
            await tx.deployment.update({
              where: { id: deploymentId },
              data: { checkRunId },
            });
          },
        });
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  }

  async claimDelivery(delivery: FeedbackDeliveryIdentity): Promise<FeedbackDeliveryClaim> {
    validateDelivery(delivery);
    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const existing = await tx.kafkaDelivery.findUnique({
        where: { consumerName_topic_partition_offset: deliveryKey(delivery) },
      });
      assertDeliveryIdentity(existing, delivery);
      if (existing === null) {
        await tx.kafkaDelivery.create({
          data: {
            ...deliveryCreateData(delivery),
            status: "RECEIVED",
            attempts: 1,
            lastAttemptAt: now,
          },
        });
        return { kind: "CLAIMED", attempts: 1 };
      }
      if (existing.status === "PROCESSED") {
        return { kind: "PROCESSED", attempts: existing.attempts };
      }
      if (existing.status === "DEAD_LETTER") {
        return { kind: "DEAD_LETTER", attempts: existing.attempts };
      }
      if (existing.status === "RETRY_SCHEDULED" && existing.availableAt > now) {
        return {
          kind: "RETRY_NOT_DUE",
          attempts: existing.attempts,
          availableAt: existing.availableAt,
        };
      }
      const updated = await tx.kafkaDelivery.update({
        where: { id: existing.id },
        data: {
          status: "RECEIVED",
          attempts: { increment: 1 },
          lastAttemptAt: now,
          processedAt: null,
          deadLetteredAt: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        },
      });
      return { kind: "CLAIMED", attempts: updated.attempts };
    });
  }

  async markDeliveryProcessed(delivery: FeedbackDeliveryIdentity): Promise<void> {
    validateDelivery(delivery);
    await this.prisma.$transaction(async (tx) => {
      const now = await serverNow(tx);
      const existing = await tx.kafkaDelivery.findUnique({
        where: { consumerName_topic_partition_offset: deliveryKey(delivery) },
      });
      assertDeliveryIdentity(existing, delivery);
      if (existing === null) throw new Error("feedback delivery was not claimed");
      if (existing.status === "DEAD_LETTER") return;
      await tx.kafkaDelivery.update({
        where: { id: existing.id },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastAttemptAt: now,
          errorCode: null,
          errorMessage: null,
          deadLetteredAt: null,
          updatedAt: now,
        },
      });
    });
  }

  scheduleRetry(input: FeedbackDeliveryFailureInput): Promise<FeedbackDeliveryOutcome> {
    return this.recordDeliveryFailure(input, "RETRY_SCHEDULED");
  }

  recordDeadLetter(input: FeedbackDeliveryFailureInput): Promise<FeedbackDeliveryOutcome> {
    return this.recordDeliveryFailure(input, "DEAD_LETTER");
  }

  private async recordDeliveryFailure(
    input: FeedbackDeliveryFailureInput,
    requestedStatus: "RETRY_SCHEDULED" | "DEAD_LETTER",
  ): Promise<FeedbackDeliveryOutcome> {
    validateDelivery(input.delivery);
    validateError(input.errorCode, input.message);
    validateFailureEvent(input.event);
    const maxAttempts = boundedInteger(
      input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      1,
      MAX_ATTEMPTS,
      "maxAttempts",
    );
    const retryBaseDelayMs = boundedInteger(
      input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      1,
      MAX_RETRY_DELAY_MS,
      "retryBaseDelayMs",
    );
    const retryMaxDelayMs = boundedInteger(
      input.retryMaxDelayMs ?? MAX_RETRY_DELAY_MS,
      1,
      MAX_RETRY_DELAY_MS,
      "retryMaxDelayMs",
    );
    if (retryBaseDelayMs > retryMaxDelayMs) throw new Error("retry delay range is invalid");

    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const existing = await tx.kafkaDelivery.findUnique({
        where: { consumerName_topic_partition_offset: deliveryKey(input.delivery) },
      });
      assertDeliveryIdentity(existing, input.delivery);
      if (existing?.status === "DEAD_LETTER") {
        return {
          outcome: "DEAD_LETTER",
          attempts: existing.attempts,
          availableAt: existing.availableAt,
          deadLetteredAt: existing.deadLetteredAt,
        };
      }
      const attempts = existing?.attempts ?? 1;
      const terminal = requestedStatus === "DEAD_LETTER" || attempts >= maxAttempts;
      const availableAt = terminal
        ? now
        : new Date(
            now.getTime() + retryDelayMs(attempts, retryBaseDelayMs, retryMaxDelayMs, this.random),
          );
      const data = {
        status: terminal ? "DEAD_LETTER" : "RETRY_SCHEDULED",
        availableAt,
        lastAttemptAt: now,
        processedAt: null,
        deadLetteredAt: terminal ? now : null,
        errorCode: input.errorCode,
        errorMessage: redactErrorMessage(input.message),
        updatedAt: now,
      } as const;
      if (existing === null) {
        await tx.kafkaDelivery.create({
          data: {
            ...deliveryCreateData(input.delivery, input.event),
            ...data,
            attempts,
          },
        });
      } else {
        await tx.kafkaDelivery.update({ where: { id: existing.id }, data });
      }
      return {
        outcome: terminal ? "DEAD_LETTER" : "RETRY_SCHEDULED",
        attempts,
        availableAt,
        deadLetteredAt: terminal ? now : null,
      };
    });
  }
}

type TransactionClient = Prisma.TransactionClient;
type FeedbackDeploymentRow = Prisma.DeploymentGetPayload<{
  select: {
    id: true;
    environmentId: true;
    commitSha: true;
    status: true;
    failureStage: true;
    failureCode: true;
    failureMessage: true;
    failureRetryable: true;
    checkRunId: true;
    imageDigest: true;
    environment: {
      select: {
        desiredCommitSha: true;
        pullRequest: { select: { number: true } };
        project: {
          select: {
            repositoryFullName: true;
            installation: { select: { githubInstallationId: true } };
          };
        };
      };
    };
  };
}>;

async function readFeedbackContext(
  client: PrismaClient | TransactionClient,
  deploymentId: string,
): Promise<DeploymentFeedbackContext | null> {
  const row: FeedbackDeploymentRow | null = await client.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      environmentId: true,
      commitSha: true,
      status: true,
      failureStage: true,
      failureCode: true,
      failureMessage: true,
      failureRetryable: true,
      checkRunId: true,
      imageDigest: true,
      environment: {
        select: {
          desiredCommitSha: true,
          pullRequest: { select: { number: true } },
          project: {
            select: {
              repositoryFullName: true,
              installation: { select: { githubInstallationId: true } },
            },
          },
        },
      },
    },
  });
  if (row === null) return null;
  return {
    deploymentId: row.id,
    environmentId: row.environmentId,
    commitSha: row.commitSha,
    desiredCommitSha: row.environment.desiredCommitSha,
    status: deploymentStatusSchema.parse(row.status),
    failureStage: row.failureStage,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    failureRetryable: row.failureRetryable,
    checkRunId: row.checkRunId,
    imageDigest: row.imageDigest,
    repositoryFullName: row.environment.project.repositoryFullName,
    installationId: row.environment.project.installation.githubInstallationId.toString(),
    pullRequestNumber: row.environment.pullRequest?.number ?? null,
  };
}

async function serverNow(client: TransactionClient): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("database server time is unavailable");
  }
  return now;
}

function validateDelivery(delivery: FeedbackDeliveryIdentity): void {
  validateConsumerName(delivery.consumerName);
  if (!/^[A-Za-z0-9._:-]{1,249}$/.test(delivery.topic))
    throw new Error("feedback topic is invalid");
  if (!Number.isInteger(delivery.partition) || delivery.partition < 0)
    throw new Error("feedback partition is invalid");
  if (toBigInt(delivery.offset) < 0n) throw new Error("feedback offset is invalid");
  if (!/^[a-f0-9]{64}$/i.test(delivery.payloadDigest))
    throw new Error("feedback payload digest is invalid");
  for (const [name, value] of [
    ["eventId", delivery.eventId],
    ["environmentId", delivery.environmentId],
    ["aggregateId", delivery.aggregateId],
  ] as const) {
    if (value !== undefined) validateUuid(value, name);
  }
  if (delivery.eventType !== undefined && !/^[a-z][a-z0-9.-]{0,127}$/.test(delivery.eventType)) {
    throw new Error("feedback event type is invalid");
  }
}

function validateFailureEvent(event: FeedbackDeliveryFailureInput["event"]): void {
  if (event === undefined) return;
  validateUuid(event.eventId, "eventId");
  validateUuid(event.environmentId, "environmentId");
  validateUuid(event.aggregateId, "aggregateId");
  if (!/^[a-z][a-z0-9.-]{0,127}$/.test(event.eventType))
    throw new Error("feedback event type is invalid");
}

function assertDeliveryIdentity(
  existing: {
    payloadDigest: string;
    eventId: string | null;
    eventType: string | null;
    environmentId: string | null;
    aggregateId: string | null;
  } | null,
  delivery: FeedbackDeliveryIdentity,
): void {
  if (
    existing !== null &&
    (existing.payloadDigest !== delivery.payloadDigest ||
      existing.eventId !== (delivery.eventId ?? null) ||
      existing.eventType !== (delivery.eventType ?? null) ||
      existing.environmentId !== (delivery.environmentId ?? null) ||
      existing.aggregateId !== (delivery.aggregateId ?? null))
  ) {
    throw new DeploymentFeedbackDeliveryConflictError();
  }
}

function deliveryKey(delivery: FeedbackDeliveryIdentity) {
  return {
    consumerName: delivery.consumerName,
    topic: delivery.topic,
    partition: delivery.partition,
    offset: toBigInt(delivery.offset),
  };
}

function deliveryCreateData(
  delivery: FeedbackDeliveryIdentity,
  event?: FeedbackDeliveryFailureInput["event"],
) {
  return {
    id: randomUUID(),
    consumerName: delivery.consumerName,
    topic: delivery.topic,
    partition: delivery.partition,
    offset: toBigInt(delivery.offset),
    eventId: event?.eventId ?? delivery.eventId ?? null,
    eventType: event?.eventType ?? delivery.eventType ?? null,
    environmentId: event?.environmentId ?? delivery.environmentId ?? null,
    aggregateId: event?.aggregateId ?? delivery.aggregateId ?? null,
    payloadDigest: delivery.payloadDigest,
  };
}

async function withSerializableRetry<T>(
  prisma: PrismaClient,
  callback: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 4) throw error;
    }
  }
  throw new Error("feedback transaction retry limit exhausted");
}

function isSerializationConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002")
  );
}

function validateUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function validateCheckRunId(value: string): void {
  if (!/^[1-9][0-9]{0,20}$/.test(value)) throw new Error("checkRunId is invalid");
}

function validateConsumerName(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error("feedback consumer name is invalid");
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} is invalid`);
  return value;
}

function validateError(code: string, message: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw new Error("feedback error code is invalid");
  if (message.trim().length === 0 || message.length > MAX_ERROR_MESSAGE_LENGTH) {
    throw new Error("feedback error message is invalid");
  }
}

function redactErrorMessage(message: string): string {
  return message
    .trim()
    .replace(/(ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization\s*:\s*)?(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[REDACTED]@[REDACTED]")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function retryDelayMs(
  attempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const sample = random();
  const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));
  return Math.max(1, Math.min(maxDelayMs, Math.floor(exponential * (1 + (jitter - 0.5) * 0.25))));
}

function toBigInt(value: bigint | number | string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error("feedback offset is invalid");
  }
}
