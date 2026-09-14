import { randomUUID } from "node:crypto";
import {
  canTransitionDeployment,
  type DeploymentRequested,
  type DeploymentStatus,
  deploymentRequestedSchema,
  deploymentStatusSchema,
} from "@previewforge/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";

const MAX_TRANSACTION_RETRIES = 8;
const INITIAL_RETRY_DELAY_MS = 5;
const MAX_TRANSACTION_RETRY_DELAY_MS = 100;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_NAME_LENGTH = 128;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DELIVERY_MAX_ATTEMPTS = 5;
const MAX_DELIVERY_ATTEMPTS = 100;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const MAX_JITTER_RATIO = 0.25;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEPLOYMENT_REQUEST_TOPIC = "previewforge.deployment-requests.v1";

export type KafkaDeliveryIdentity = {
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
export type DeploymentClaimInput = {
  delivery: KafkaDeliveryIdentity;
  event: unknown;
  workerId: string;
  leaseTtlMs: number;
  faultInjector?: (stage: "before-receipt") => void;
};
export type DeploymentClaimResult =
  | {
      kind: "CLAIMED" | "RECLAIMED";
      deploymentId: string;
      environmentId: string;
      commitSha: string;
      leaseToken: string;
      leaseGeneration: number;
    }
  | {
      kind: "DUPLICATE_ACTIVE_LEASE" | "DUPLICATE_TERMINAL";
      deploymentId: string;
      environmentId: string;
      leaseGeneration: number;
    }
  | { kind: "SUPERSEDED"; deploymentId: string; environmentId: string; leaseGeneration: number };
export type LeaseInput = {
  deploymentId: string;
  leaseToken: string;
  leaseGeneration: number;
  expectedDesiredSha: string;
  leaseTtlMs?: number;
};
export type KafkaDeliveryOutcomeInput = {
  delivery: KafkaDeliveryIdentity;
  event?: Partial<Pick<DeploymentRequested, "eventId" | "eventType" | "environmentId">>;
  errorCode: string;
  message: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};
export type KafkaDeliveryOutcomeResult = {
  outcome: "RETRY_SCHEDULED" | "DEAD_LETTER";
  attempts: number;
  availableAt: Date;
  deadLetteredAt: Date | null;
};

export class DeploymentClaimValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentClaimValidationError";
  }
}
export class KafkaDeliveryIdentityConflictError extends Error {
  readonly code = "KAFKA_DELIVERY_IDENTITY_CONFLICT";
  constructor() {
    super("Kafka delivery offset identity conflicts with an existing delivery");
    this.name = "KafkaDeliveryIdentityConflictError";
  }
}
export class KafkaDeliveryOutcomeConflictError extends Error {
  readonly code = "KAFKA_DELIVERY_PROCESSED";
  constructor() {
    super("processed Kafka delivery cannot receive another outcome");
    this.name = "KafkaDeliveryOutcomeConflictError";
  }
}
export type DeploymentClaimConflictCode =
  | "DEPLOYMENT_AGGREGATE_MISMATCH"
  | "DEPLOYMENT_CLAIM_INVARIANT"
  | "DEPLOYMENT_CLAIM_RACE"
  | "DEPLOYMENT_STATE_INVALID"
  | "DEPLOYMENT_DURABLE_CONFLICT"
  | "DEPLOYMENT_DATABASE_TIME_UNAVAILABLE"
  | KafkaDeliveryNotClaimableCode;
export class DeploymentClaimConflictError extends Error {
  readonly code: DeploymentClaimConflictCode;
  constructor(code: DeploymentClaimConflictCode, message: string) {
    super(message);
    this.name = "DeploymentClaimConflictError";
    this.code = code;
  }
}
export type KafkaDeliveryNotClaimableCode = "DELIVERY_DEAD_LETTER" | "DELIVERY_RETRY_NOT_DUE";
export class KafkaDeliveryNotClaimableError extends DeploymentClaimConflictError {
  override readonly code: KafkaDeliveryNotClaimableCode;
  constructor(code: KafkaDeliveryNotClaimableCode) {
    super(
      code,
      code === "DELIVERY_DEAD_LETTER"
        ? "Kafka delivery is dead-lettered"
        : "Kafka delivery retry is not due",
    );
    this.name = "KafkaDeliveryNotClaimableError";
    this.code = code;
  }
}
export class LeaseFenceError extends Error {
  constructor(message = "deployment lease is no longer current") {
    super(message);
    this.name = "LeaseFenceError";
  }
}

type TransactionClient = Prisma.TransactionClient;
type DeploymentWithEnvironment = Prisma.DeploymentGetPayload<{
  include: {
    environment: {
      select: {
        desiredCommitSha: true;
        project: {
          select: {
            id: true;
            repositoryFullName: true;
            installation: { select: { githubInstallationId: true } };
          };
        };
      };
    };
  };
}>;

export class DeploymentClaimRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly random: () => number = Math.random,
  ) {}

  async claimRequestedDeployment(input: DeploymentClaimInput): Promise<DeploymentClaimResult> {
    const event = validateClaimInput(input);
    return withSerializableRetry(
      this.prisma,
      async (tx) => {
        const now = await serverNow(tx);
        const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
        const delivery = await ensureDelivery(tx, input.delivery, event, now);
        const deployment = await tx.deployment.findUnique({
          where: { id: event.deploymentId },
          include: {
            environment: {
              select: {
                desiredCommitSha: true,
                project: {
                  select: {
                    id: true,
                    repositoryFullName: true,
                    installation: { select: { githubInstallationId: true } },
                  },
                },
              },
            },
          },
        });
        if (
          deployment === null ||
          deployment.environmentId !== event.environmentId ||
          deployment.commitSha !== event.commitSha
        )
          throw new DeploymentClaimConflictError(
            "DEPLOYMENT_AGGREGATE_MISMATCH",
            "deployment request does not match its aggregate",
          );
        if (
          deployment.environment.project.id !== event.projectId ||
          deployment.environment.project.repositoryFullName !== event.repositoryFullName ||
          deployment.environment.project.installation.githubInstallationId.toString() !==
            event.installationId
        )
          throw new DeploymentClaimConflictError(
            "DEPLOYMENT_AGGREGATE_MISMATCH",
            "deployment request does not match its project aggregate",
          );
        const receipt = await tx.consumerReceipt.findUnique({
          where: {
            consumerName_eventId: {
              consumerName: input.delivery.consumerName,
              eventId: event.eventId,
            },
          },
        });
        if (receipt !== null) {
          if (deployment.status === "QUEUED")
            throw new DeploymentClaimConflictError(
              "DEPLOYMENT_CLAIM_INVARIANT",
              "consumer receipt exists for a queued deployment",
            );
          if (
            deployment.status === "CLONING" &&
            deployment.leaseExpiresAt !== null &&
            deployment.leaseExpiresAt <= now
          ) {
            if (deployment.environment.desiredCommitSha !== event.commitSha) {
              await supersedeDeployment(tx, deployment, now);
              await markDeliveryProcessed(tx, delivery.id, now);
              return {
                kind: "SUPERSEDED",
                deploymentId: deployment.id,
                environmentId: deployment.environmentId,
                leaseGeneration: deployment.leaseGeneration,
              };
            }
            const takeover = await takeOverExpiredLease(
              tx,
              deployment,
              input.workerId,
              leaseExpiresAt,
              now,
            );
            if (takeover === null)
              throw new DeploymentClaimConflictError(
                "DEPLOYMENT_CLAIM_RACE",
                "deployment lease takeover lost a race",
              );
            await markDeliveryProcessed(tx, delivery.id, now);
            return {
              kind: "RECLAIMED",
              deploymentId: deployment.id,
              environmentId: deployment.environmentId,
              commitSha: deployment.commitSha,
              leaseToken: takeover.leaseToken,
              leaseGeneration: takeover.leaseGeneration,
            };
          }
          await markDeliveryProcessed(tx, delivery.id, now);
          const duplicateKind =
            deployment.status === "CLONING" && deployment.leaseExpiresAt !== null
              ? "DUPLICATE_ACTIVE_LEASE"
              : "DUPLICATE_TERMINAL";
          return {
            kind: duplicateKind,
            deploymentId: deployment.id,
            environmentId: deployment.environmentId,
            leaseGeneration: deployment.leaseGeneration,
          };
        }
        if (delivery.status === "PROCESSED") {
          throw new DeploymentClaimConflictError(
            "DEPLOYMENT_CLAIM_INVARIANT",
            "processed Kafka delivery has no semantic receipt",
          );
        }
        if (deployment.status === "QUEUED") {
          if (deployment.environment.desiredCommitSha !== event.commitSha) {
            await supersedeDeployment(tx, deployment, now);
            await tx.consumerReceipt.create({
              data: {
                consumerName: input.delivery.consumerName,
                eventId: event.eventId,
                processedAt: now,
              },
            });
            await markDeliveryProcessed(tx, delivery.id, now);
            return {
              kind: "SUPERSEDED",
              deploymentId: deployment.id,
              environmentId: deployment.environmentId,
              leaseGeneration: deployment.leaseGeneration,
            };
          }
          const leaseToken = randomUUID();
          const updated = await tx.deployment.updateManyAndReturn({
            where: {
              id: deployment.id,
              status: "QUEUED",
              commitSha: event.commitSha,
              leaseToken: null,
              environment: { desiredCommitSha: event.commitSha },
            },
            data: {
              status: "CLONING",
              leaseToken,
              leaseOwner: input.workerId,
              leaseGeneration: { increment: 1 },
              leaseAcquiredAt: now,
              leaseRenewedAt: null,
              leaseExpiresAt,
              startedAt: now,
              updatedAt: now,
            },
          });
          const claimed = updated[0];
          if (claimed === undefined)
            throw new DeploymentClaimConflictError(
              "DEPLOYMENT_CLAIM_RACE",
              "deployment claim lost a race",
            );
          await createTransitionOutbox(tx, claimed, "QUEUED", "CLONING", now);
          input.faultInjector?.("before-receipt");
          await tx.consumerReceipt.create({
            data: {
              consumerName: input.delivery.consumerName,
              eventId: event.eventId,
              processedAt: now,
            },
          });
          await markDeliveryProcessed(tx, delivery.id, now);
          return {
            kind: "CLAIMED",
            deploymentId: claimed.id,
            environmentId: claimed.environmentId,
            commitSha: claimed.commitSha,
            leaseToken,
            leaseGeneration: claimed.leaseGeneration,
          };
        }
        if (isTerminal(deployment.status)) {
          await tx.consumerReceipt.create({
            data: {
              consumerName: input.delivery.consumerName,
              eventId: event.eventId,
              processedAt: now,
            },
          });
          await markDeliveryProcessed(tx, delivery.id, now);
          return {
            kind: "DUPLICATE_TERMINAL",
            deploymentId: deployment.id,
            environmentId: deployment.environmentId,
            leaseGeneration: deployment.leaseGeneration,
          };
        }
        throw new DeploymentClaimConflictError(
          "DEPLOYMENT_STATE_INVALID",
          "deployment is already in an unsupported state",
        );
      },
      { retryUniqueConflict: true },
    );
  }

  async renewLease(input: LeaseInput): Promise<{ leaseExpiresAt: Date; leaseGeneration: number }> {
    validateLeaseInput(input);
    const ttl = input.leaseTtlMs ?? 30_000;
    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const result = await tx.deployment.updateManyAndReturn({
        where: {
          id: input.deploymentId,
          status: "CLONING",
          leaseToken: input.leaseToken,
          leaseGeneration: input.leaseGeneration,
          leaseExpiresAt: { gt: now },
          commitSha: input.expectedDesiredSha,
          environment: { desiredCommitSha: input.expectedDesiredSha },
        },
        data: {
          leaseRenewedAt: now,
          leaseExpiresAt: new Date(now.getTime() + ttl),
          updatedAt: now,
        },
        select: { leaseExpiresAt: true, leaseGeneration: true },
      });
      const renewed = result[0];
      if (renewed === undefined || renewed.leaseExpiresAt === null) throw new LeaseFenceError();
      return { leaseExpiresAt: renewed.leaseExpiresAt, leaseGeneration: renewed.leaseGeneration };
    });
  }
  async releaseLease(input: LeaseInput): Promise<void> {
    validateLeaseInput(input);
    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const result = await tx.deployment.updateMany({
        where: {
          id: input.deploymentId,
          status: "CLONING",
          leaseToken: input.leaseToken,
          leaseGeneration: input.leaseGeneration,
          leaseExpiresAt: { gt: now },
          commitSha: input.expectedDesiredSha,
          environment: { desiredCommitSha: input.expectedDesiredSha },
        },
        data: {
          leaseToken: null,
          leaseOwner: null,
          leaseAcquiredAt: null,
          leaseRenewedAt: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
      if (result.count !== 1) throw new LeaseFenceError();
    });
  }
  async assertSideEffectAllowed(input: LeaseInput): Promise<DeploymentWithEnvironment> {
    validateLeaseInput(input);
    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const deployment = await tx.deployment.findFirst({
        where: {
          id: input.deploymentId,
          status: "CLONING",
          leaseToken: input.leaseToken,
          leaseGeneration: input.leaseGeneration,
          leaseExpiresAt: { gt: now },
          commitSha: input.expectedDesiredSha,
          environment: { desiredCommitSha: input.expectedDesiredSha },
        },
        include: {
          environment: {
            select: {
              desiredCommitSha: true,
              project: {
                select: {
                  id: true,
                  repositoryFullName: true,
                  installation: { select: { githubInstallationId: true } },
                },
              },
            },
          },
        },
      });
      if (deployment === null) throw new LeaseFenceError();
      return deployment;
    });
  }
  async supersedeStaleLease(input: LeaseInput): Promise<boolean> {
    validateLeaseInput(input);
    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const deployment = await tx.deployment.findFirst({
        where: {
          id: input.deploymentId,
          status: "CLONING",
          leaseToken: input.leaseToken,
          leaseGeneration: input.leaseGeneration,
          leaseExpiresAt: { gt: now },
          commitSha: input.expectedDesiredSha,
          environment: { desiredCommitSha: { not: input.expectedDesiredSha } },
        },
        include: {
          environment: {
            select: {
              desiredCommitSha: true,
              project: {
                select: {
                  id: true,
                  repositoryFullName: true,
                  installation: { select: { githubInstallationId: true } },
                },
              },
            },
          },
        },
      });
      if (deployment === null) throw new LeaseFenceError();
      await supersedeDeployment(tx, deployment, now);
      return true;
    });
  }
  recordDeadLetter(input: KafkaDeliveryOutcomeInput): Promise<KafkaDeliveryOutcomeResult> {
    validateOutcomeOptions(input, false);
    return this.recordDeliveryOutcome(input, "DEAD_LETTER");
  }
  scheduleRetry(input: KafkaDeliveryOutcomeInput): Promise<KafkaDeliveryOutcomeResult> {
    validateOutcomeOptions(input, true);
    return this.recordDeliveryOutcome(input, "RETRY_SCHEDULED");
  }
  private async recordDeliveryOutcome(
    input: KafkaDeliveryOutcomeInput,
    status: "DEAD_LETTER" | "RETRY_SCHEDULED",
  ): Promise<KafkaDeliveryOutcomeResult> {
    validateDeliveryIdentity(input.delivery);
    validateError(input.errorCode, input.message);
    const maxAttempts = input.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS;
    const retryBaseDelayMs = input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const retryMaxDelayMs = input.retryMaxDelayMs ?? MAX_RETRY_DELAY_MS;
    return withSerializableRetry(this.prisma, async (tx) => {
      const now = await serverNow(tx);
      const existing = await tx.kafkaDelivery.findUnique({
        where: { consumerName_topic_partition_offset: deliveryKey(input.delivery) },
      });
      const eventId = input.event?.eventId ?? input.delivery.eventId;
      const eventType = input.event?.eventType ?? input.delivery.eventType;
      const environmentId = input.event?.environmentId ?? input.delivery.environmentId;
      if (
        existing !== null &&
        (existing.payloadDigest !== input.delivery.payloadDigest ||
          existing.eventId !== (eventId ?? null) ||
          existing.eventType !== (eventType ?? null) ||
          existing.environmentId !== (environmentId ?? null) ||
          existing.aggregateId !== (input.delivery.aggregateId ?? null))
      )
        throw new KafkaDeliveryIdentityConflictError();
      if (existing?.status === "PROCESSED") throw new KafkaDeliveryOutcomeConflictError();
      if (existing?.status === "DEAD_LETTER") {
        return {
          outcome: "DEAD_LETTER",
          attempts: existing.attempts,
          availableAt: existing.availableAt,
          deadLetteredAt: existing.deadLetteredAt,
        };
      }
      const attempts = existing === null ? 1 : existing.attempts + 1;
      const terminal = status === "DEAD_LETTER" || attempts >= maxAttempts;
      const availableAt = terminal
        ? now
        : new Date(
            now.getTime() +
              retryDelayMsForAttempt(attempts, retryBaseDelayMs, retryMaxDelayMs, this.random),
          );
      const commonData = {
        status: terminal ? "DEAD_LETTER" : "RETRY_SCHEDULED",
        lastAttemptAt: now,
        processedAt: null,
        deadLetteredAt: terminal ? now : null,
        errorCode: input.errorCode,
        errorMessage: redactErrorMessage(input.message),
        updatedAt: now,
      };
      if (existing === null)
        await tx.kafkaDelivery.create({
          data: {
            ...deliveryCreateData(input.delivery, input.event),
            ...commonData,
            attempts,
            availableAt,
          },
        });
      else
        await tx.kafkaDelivery.update({
          where: { id: existing.id },
          data: { ...commonData, attempts, availableAt },
        });
      return {
        outcome: terminal ? "DEAD_LETTER" : "RETRY_SCHEDULED",
        attempts,
        availableAt,
        deadLetteredAt: terminal ? now : null,
      };
    });
  }
}

function validateClaimInput(input: DeploymentClaimInput): DeploymentRequested {
  validateDeliveryIdentity(input.delivery);
  if (input.delivery.topic !== DEPLOYMENT_REQUEST_TOPIC)
    throw new DeploymentClaimValidationError("deployment request topic is invalid");
  validateName(input.workerId, "workerId");
  validateBoundedDuration(input.leaseTtlMs, "leaseTtlMs", false);
  const parsed = deploymentRequestedSchema.safeParse(input.event);
  if (!parsed.success) throw new DeploymentClaimValidationError("deployment request is invalid");
  const event = parsed.data;
  if (
    input.delivery.eventId === undefined ||
    input.delivery.eventType === undefined ||
    input.delivery.environmentId === undefined ||
    input.delivery.aggregateId === undefined
  )
    throw new DeploymentClaimValidationError("claim delivery identity headers are required");
  if (
    input.delivery.eventId !== event.eventId ||
    input.delivery.eventType !== event.eventType ||
    input.delivery.environmentId !== event.environmentId ||
    input.delivery.aggregateId !== event.deploymentId
  )
    throw new KafkaDeliveryIdentityConflictError();
  return event;
}
function validateDeliveryIdentity(delivery: KafkaDeliveryIdentity): void {
  validateName(delivery.consumerName, "consumerName");
  validateName(delivery.topic, "topic", 249);
  if (!Number.isInteger(delivery.partition) || delivery.partition < 0)
    throw new DeploymentClaimValidationError("partition must be non-negative");
  if (toBigInt(delivery.offset) < 0n)
    throw new DeploymentClaimValidationError("offset must be non-negative");
  if (!SHA256_PATTERN.test(delivery.payloadDigest))
    throw new DeploymentClaimValidationError("payloadDigest must be a SHA-256 digest");
  for (const [name, value] of [
    ["eventId", delivery.eventId],
    ["environmentId", delivery.environmentId],
    ["aggregateId", delivery.aggregateId],
  ] as const)
    if (value !== undefined && !isUuid(value))
      throw new DeploymentClaimValidationError(`${name} must be a UUID`);
  if (delivery.eventType !== undefined && !/^[a-z][a-z0-9.-]{0,127}$/.test(delivery.eventType))
    throw new DeploymentClaimValidationError("eventType is invalid");
}
function validateLeaseInput(input: LeaseInput): void {
  if (!isUuid(input.deploymentId))
    throw new DeploymentClaimValidationError("deploymentId must be a UUID");
  if (!isUuid(input.leaseToken))
    throw new DeploymentClaimValidationError("leaseToken must be a UUID");
  if (!Number.isInteger(input.leaseGeneration) || input.leaseGeneration <= 0)
    throw new DeploymentClaimValidationError("leaseGeneration must be positive");
  if (!/^[0-9a-f]{40}$/i.test(input.expectedDesiredSha))
    throw new DeploymentClaimValidationError("expectedDesiredSha must be a commit SHA");
  if (input.leaseTtlMs !== undefined)
    validateBoundedDuration(input.leaseTtlMs, "leaseTtlMs", false);
}
function validateBoundedDuration(value: number, field: string, allowZero: boolean): void {
  if (!Number.isInteger(value) || (!allowZero && value <= 0) || (allowZero && value < 0))
    throw new DeploymentClaimValidationError(
      `${field} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  const maximum = field === "retryDelayMs" ? MAX_RETRY_DELAY_MS : MAX_LEASE_TTL_MS;
  if (value > maximum)
    throw new DeploymentClaimValidationError(`${field} exceeds the maximum allowed duration`);
}
function validateOutcomeOptions(input: KafkaDeliveryOutcomeInput, scheduled: boolean): void {
  validatePositiveIntegerOption(
    input.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS,
    "maxAttempts",
    MAX_DELIVERY_ATTEMPTS,
  );
  if (!scheduled && input.retryBaseDelayMs === undefined && input.retryMaxDelayMs === undefined)
    return;
  const base = input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maximum = input.retryMaxDelayMs ?? MAX_RETRY_DELAY_MS;
  validatePositiveIntegerOption(base, "retryBaseDelayMs", MAX_RETRY_DELAY_MS);
  validatePositiveIntegerOption(maximum, "retryMaxDelayMs", MAX_RETRY_DELAY_MS);
  if (base > maximum)
    throw new DeploymentClaimValidationError("retryBaseDelayMs cannot exceed retryMaxDelayMs");
}
function validatePositiveIntegerOption(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new DeploymentClaimValidationError(`${field} is outside the supported range`);
}
function validateName(value: string, field: string, max = MAX_NAME_LENGTH): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  )
    throw new DeploymentClaimValidationError(`${field} is invalid`);
}
function deliveryKey(delivery: KafkaDeliveryIdentity) {
  return {
    consumerName: delivery.consumerName,
    topic: delivery.topic,
    partition: delivery.partition,
    offset: toBigInt(delivery.offset),
  };
}
function deliveryCreateData(
  delivery: KafkaDeliveryIdentity,
  event?: KafkaDeliveryOutcomeInput["event"],
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
    aggregateId: delivery.aggregateId ?? null,
    payloadDigest: delivery.payloadDigest,
  };
}
async function ensureDelivery(
  tx: TransactionClient,
  delivery: KafkaDeliveryIdentity,
  event: DeploymentRequested,
  now: Date,
) {
  const existing = await tx.kafkaDelivery.findUnique({
    where: { consumerName_topic_partition_offset: deliveryKey(delivery) },
  });
  if (
    existing !== null &&
    (existing.payloadDigest !== delivery.payloadDigest ||
      existing.eventId !== event.eventId ||
      existing.eventType !== event.eventType ||
      existing.environmentId !== event.environmentId ||
      existing.aggregateId !== event.deploymentId)
  )
    throw new KafkaDeliveryIdentityConflictError();
  if (existing === null)
    return tx.kafkaDelivery.create({
      data: {
        ...deliveryCreateData(delivery, event),
        eventId: event.eventId,
        eventType: event.eventType,
        environmentId: event.environmentId,
        aggregateId: event.deploymentId,
        lastAttemptAt: now,
      },
    });
  if (existing.status === "DEAD_LETTER")
    throw new KafkaDeliveryNotClaimableError("DELIVERY_DEAD_LETTER");
  if (existing.status === "RETRY_SCHEDULED") {
    if (existing.availableAt > now)
      throw new KafkaDeliveryNotClaimableError("DELIVERY_RETRY_NOT_DUE");
    return tx.kafkaDelivery.update({
      where: { id: existing.id },
      data: {
        status: "RECEIVED",
        attempts: { increment: 1 },
        lastAttemptAt: now,
        processedAt: null,
        errorCode: null,
        errorMessage: null,
        deadLetteredAt: null,
        updatedAt: now,
      },
    });
  }
  if (existing.status === "PROCESSED") return existing;
  return existing;
}
async function markDeliveryProcessed(tx: TransactionClient, id: string, now: Date): Promise<void> {
  await tx.kafkaDelivery.update({
    where: { id },
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
}
async function createTransitionOutbox(
  tx: TransactionClient,
  deployment: Pick<DeploymentWithEnvironment, "id" | "environmentId" | "commitSha">,
  fromStatus: DeploymentStatus,
  toStatus: DeploymentStatus,
  occurredAt: Date,
): Promise<void> {
  if (!canTransitionDeployment(fromStatus, toStatus))
    throw new DeploymentClaimConflictError(
      "DEPLOYMENT_STATE_INVALID",
      "illegal deployment transition",
    );
  const eventId = randomUUID();
  await tx.outboxEvent.create({
    data: {
      id: eventId,
      eventType: "deployment.stage-changed.v1",
      aggregateType: "deployment",
      aggregateId: deployment.id,
      payload: {
        eventId,
        eventType: "deployment.stage-changed.v1",
        occurredAt: occurredAt.toISOString(),
        deploymentId: deployment.id,
        environmentId: deployment.environmentId,
        commitSha: deployment.commitSha,
        fromStatus,
        toStatus,
      },
    },
  });
}
async function supersedeDeployment(
  tx: TransactionClient,
  deployment: DeploymentWithEnvironment,
  occurredAt: Date,
): Promise<void> {
  const currentStatus = deploymentStatusSchema.parse(deployment.status);
  if (!canTransitionDeployment(currentStatus, "SUPERSEDED")) {
    if (isTerminal(currentStatus)) return;
    throw new DeploymentClaimConflictError(
      "DEPLOYMENT_STATE_INVALID",
      "deployment cannot be superseded",
    );
  }
  const updated = await tx.deployment.updateManyAndReturn({
    where: {
      id: deployment.id,
      status: currentStatus,
      commitSha: deployment.commitSha,
      environment: { desiredCommitSha: { not: deployment.commitSha } },
    },
    data: {
      status: "SUPERSEDED",
      finishedAt: occurredAt,
      leaseToken: null,
      leaseOwner: null,
      leaseAcquiredAt: null,
      leaseRenewedAt: null,
      leaseExpiresAt: null,
      updatedAt: occurredAt,
    },
  });
  if (updated[0] !== undefined)
    await createTransitionOutbox(tx, deployment, currentStatus, "SUPERSEDED", occurredAt);
}
async function takeOverExpiredLease(
  tx: TransactionClient,
  deployment: DeploymentWithEnvironment,
  workerId: string,
  leaseExpiresAt: Date,
  now: Date,
) {
  const leaseToken = randomUUID();
  const updated = await tx.deployment.updateManyAndReturn({
    where: {
      id: deployment.id,
      status: "CLONING",
      leaseToken: deployment.leaseToken,
      leaseGeneration: deployment.leaseGeneration,
      leaseExpiresAt: { lte: now },
      commitSha: deployment.commitSha,
      environment: { desiredCommitSha: deployment.commitSha },
    },
    data: {
      leaseToken,
      leaseOwner: workerId,
      leaseGeneration: { increment: 1 },
      leaseAcquiredAt: now,
      leaseRenewedAt: null,
      leaseExpiresAt,
      updatedAt: now,
    },
  });
  const claimed = updated[0];
  return claimed === undefined ? null : { leaseToken, leaseGeneration: claimed.leaseGeneration };
}
function isTerminal(status: string): boolean {
  return (
    status === "READY" || status === "FAILED" || status === "SUPERSEDED" || status === "CANCELLED"
  );
}
function validateError(code: string, message: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code))
    throw new DeploymentClaimValidationError("errorCode is invalid");
  if (
    typeof message !== "string" ||
    message.trim() === "" ||
    message.length > MAX_ERROR_MESSAGE_LENGTH ||
    hasControlCharacters(message)
  )
    throw new DeploymentClaimValidationError("error message is invalid");
}
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
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
function toBigInt(value: bigint | number | string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new DeploymentClaimValidationError("offset must be a non-negative integer");
  }
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function retryDelayMsForAttempt(
  attempt: number,
  baseDelayMs: number,
  maximumDelayMs: number,
  random: () => number,
): number {
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1)
    throw new DeploymentClaimValidationError("retry jitter must be between 0 and 1");
  const exponential = Math.min(
    maximumDelayMs,
    baseDelayMs * 2 ** Math.min(Math.max(attempt - 1, 0), 31),
  );
  return Math.min(
    maximumDelayMs,
    exponential + Math.floor(exponential * MAX_JITTER_RATIO * jitter),
  );
}
async function serverNow(tx: TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
  );
  const value = rows[0]?.now;
  if (!(value instanceof Date))
    throw new DeploymentClaimConflictError(
      "DEPLOYMENT_DATABASE_TIME_UNAVAILABLE",
      "database server time unavailable",
    );
  return value;
}
function retryDelayMs(retry: number): number {
  const exponential = Math.min(MAX_TRANSACTION_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** retry);
  return exponential + Math.floor(Math.random() * exponential);
}
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function withSerializableRetry<T>(
  prisma: PrismaClient,
  operation: (tx: TransactionClient) => Promise<T>,
  options: { retryUniqueConflict?: boolean } = {},
): Promise<T> {
  for (let retry = 0; retry <= MAX_TRANSACTION_RETRIES; retry += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (isSerializationConflict(error) && retry < MAX_TRANSACTION_RETRIES) {
        await wait(retryDelayMs(retry));
        continue;
      }
      if (
        options.retryUniqueConflict &&
        isUniqueConflict(error) &&
        retry < MAX_TRANSACTION_RETRIES
      ) {
        await wait(retryDelayMs(retry));
        continue;
      }
      if (isSerializationConflict(error))
        throw new DeploymentClaimConflictError(
          "DEPLOYMENT_CLAIM_RACE",
          "deployment transaction conflicted after bounded retries",
        );
      if (isUniqueConflict(error))
        throw new DeploymentClaimConflictError(
          "DEPLOYMENT_DURABLE_CONFLICT",
          "claim conflicts with an existing durable record",
        );
      throw error;
    }
  }
  throw new Error("unreachable");
}
function isSerializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { kind?: unknown; originalCode?: unknown; cause?: unknown };
  if (
    candidate.kind === "TransactionWriteConflict" &&
    (candidate.originalCode === "40001" || candidate.originalCode === "40P01")
  )
    return true;
  return isSerializationConflict(candidate.cause);
}
function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003", "P2004", "P2011", "P2014"].includes(error.code)
  );
}
