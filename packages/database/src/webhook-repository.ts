import { randomUUID } from "node:crypto";
import {
  type PullRequestEvent,
  pullRequestEventSchema,
  traceParentSchema,
} from "@previewforge/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";

const MAX_TRANSACTION_RETRIES = 4;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const DEFAULT_PREVIEW_TTL_SECONDS = 24 * 60 * 60;
const MAX_PREVIEW_TTL_SECONDS = 31 * 24 * 60 * 60;

export type WebhookFaultStage = "before-outbox";

export type WebhookRepositoryInput = {
  deliveryId: string;
  eventName: "pull_request";
  payloadSha256: string;
  event: PullRequestEvent;
  receivedAt?: Date;
  traceParent?: string;
};

export type WebhookProcessResult = {
  deliveryId: string;
  duplicate: boolean;
  stale: boolean;
  action: PullRequestEvent["action"];
  deploymentId?: string;
  deletionRequestId?: string;
};

export class WebhookDeliveryConflictError extends Error {
  readonly code = "WEBHOOK_DELIVERY_CONFLICT";

  constructor() {
    super("webhook delivery identity conflicts with an existing payload");
    this.name = "WebhookDeliveryConflictError";
  }
}

export class WebhookProjectNotFoundError extends Error {
  readonly code = "WEBHOOK_PROJECT_NOT_FOUND";

  constructor() {
    super("webhook repository is not imported");
    this.name = "WebhookProjectNotFoundError";
  }
}

export class WebhookRepositoryIdentityConflictError extends Error {
  readonly code = "WEBHOOK_REPOSITORY_IDENTITY_CONFLICT";

  constructor() {
    super("webhook repository rename conflicts with another imported project");
    this.name = "WebhookRepositoryIdentityConflictError";
  }
}

export class WebhookPayloadValidationError extends Error {
  readonly code = "INVALID_WEBHOOK_PAYLOAD";

  constructor() {
    super("webhook payload is invalid");
    this.name = "WebhookPayloadValidationError";
  }
}

type TransactionClient = Prisma.TransactionClient;
type FaultInjector = (stage: WebhookFaultStage) => void;

export type WebhookRepositoryOptions = {
  faultInjector?: FaultInjector;
  clock?: () => Date;
  previewTtlSeconds?: number;
};

export class WebhookRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: WebhookRepositoryOptions = {},
  ) {}

  async process(input: WebhookRepositoryInput): Promise<WebhookProcessResult> {
    validateInput(input);

    for (let retry = 0; retry <= MAX_TRANSACTION_RETRIES; retry += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => processInTransaction(tx, input, this.options),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isSerializationConflict(error) && retry < MAX_TRANSACTION_RETRIES) {
          continue;
        }

        if (isUniqueConstraintError(error)) {
          const existing = await this.prisma.webhookDelivery.findUnique({
            where: { deliveryId: input.deliveryId },
          });
          if (existing === null) {
            // A unique conflict from a concurrently created PR/environment is
            // safe to retry as a serialization-style conflict.
            if (retry < MAX_TRANSACTION_RETRIES) continue;
            throw error;
          }
          return duplicateResultOrThrow(existing, input);
        }

        throw error;
      }
    }

    throw new Error("webhook transaction retry limit exhausted");
  }
}

export async function processWebhook(
  prisma: PrismaClient,
  input: WebhookRepositoryInput,
  options?: WebhookRepositoryOptions,
): Promise<WebhookProcessResult> {
  return new WebhookRepository(prisma, options).process(input);
}

async function processInTransaction(
  tx: TransactionClient,
  input: WebhookRepositoryInput,
  options: WebhookRepositoryOptions,
): Promise<WebhookProcessResult> {
  const existing = await tx.webhookDelivery.findUnique({
    where: { deliveryId: input.deliveryId },
  });
  if (existing !== null) return duplicateResultOrThrow(existing, input);

  const installationId = parsePostgresBigInt(input.event.installationId);
  const repositoryId = parsePostgresBigInt(input.event.repositoryId);
  const project = await tx.project.findFirst({
    where: {
      githubRepositoryId: repositoryId,
      installation: { githubInstallationId: installationId },
    },
    select: {
      id: true,
      installationId: true,
      ownerId: true,
      repositoryFullName: true,
    },
  });
  if (project === null) throw new WebhookProjectNotFoundError();

  if (project.repositoryFullName !== input.event.repositoryFullName) {
    const collision = await tx.project.findFirst({
      where: {
        installationId: project.installationId,
        repositoryFullName: input.event.repositoryFullName,
        id: { not: project.id },
      },
      select: { id: true },
    });
    if (collision !== null) throw new WebhookRepositoryIdentityConflictError();
    await tx.project.update({
      where: { id: project.id },
      data: { repositoryFullName: input.event.repositoryFullName },
    });
  }

  const receivedAt = options.clock?.() ?? input.receivedAt ?? new Date();
  const expiresAt = new Date(
    receivedAt.getTime() + boundedPreviewTtlSeconds(options.previewTtlSeconds) * 1_000,
  );
  const sourceUpdatedAt = new Date(input.event.sourceTimestamp);
  const delivery = await tx.webhookDelivery.create({
    data: {
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      payloadSha256: input.payloadSha256,
      installationId: project.installationId,
      receivedAt,
      sourceUpdatedAt,
      status: "PROCESSING",
    },
  });

  const existingPullRequest = await tx.pullRequest.findUnique({
    where: {
      projectId_number: {
        projectId: project.id,
        number: input.event.pullRequestNumber,
      },
    },
    select: {
      id: true,
      projectId: true,
      number: true,
      title: true,
      headSha: true,
      state: true,
      sourceUpdatedAt: true,
      environment: {
        select: {
          id: true,
          desiredCommitSha: true,
        },
      },
    },
  });

  if (
    existingPullRequest?.sourceUpdatedAt !== null &&
    existingPullRequest?.sourceUpdatedAt !== undefined &&
    sourceUpdatedAt <= existingPullRequest.sourceUpdatedAt
  ) {
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: "IGNORED_STALE", processedAt: receivedAt },
    });
    return {
      deliveryId: input.deliveryId,
      duplicate: false,
      stale: true,
      action: input.event.action,
    };
  }

  if (input.event.action === "closed") {
    return processClosed(
      tx,
      input,
      project.id,
      delivery.id,
      existingPullRequest,
      sourceUpdatedAt,
      receivedAt,
      options.faultInjector,
    );
  }

  return processOpen(
    tx,
    input,
    project.id,
    delivery.id,
    existingPullRequest,
    sourceUpdatedAt,
    receivedAt,
    expiresAt,
    options.faultInjector,
  );
}

async function processOpen(
  tx: TransactionClient,
  input: WebhookRepositoryInput,
  projectId: string,
  deliveryRowId: string,
  existingPullRequest: PullRequestRow | null,
  sourceUpdatedAt: Date,
  receivedAt: Date,
  expiresAt: Date,
  faultInjector?: FaultInjector,
): Promise<WebhookProcessResult> {
  const pullRequest = existingPullRequest
    ? await tx.pullRequest.update({
        where: { id: existingPullRequest.id },
        data: {
          headSha: input.event.commitSha,
          state: "OPEN",
          sourceUpdatedAt,
          lastWebhookDeliveryId: input.deliveryId,
          lastWebhookEvent: input.event.action,
          lastWebhookAt: receivedAt,
          closedAt: null,
        },
        select: {
          id: true,
          number: true,
          environment: { select: { id: true, desiredCommitSha: true } },
        },
      })
    : await tx.pullRequest.create({
        data: {
          projectId,
          number: input.event.pullRequestNumber,
          headSha: input.event.commitSha,
          state: "OPEN",
          sourceUpdatedAt,
          lastWebhookDeliveryId: input.deliveryId,
          lastWebhookEvent: input.event.action,
          lastWebhookAt: receivedAt,
        },
        select: {
          id: true,
          number: true,
          environment: { select: { id: true, desiredCommitSha: true } },
        },
      });

  let environment = pullRequest.environment;
  if (environment === null) {
    environment = await tx.previewEnvironment.create({
      data: {
        projectId,
        pullRequestId: pullRequest.id,
        previewKey: `pr-${projectId}-${pullRequest.number}`,
        desiredCommitSha: input.event.commitSha,
        status: "ACTIVE",
        expiresAt,
      },
      select: { id: true, desiredCommitSha: true, expiresAt: true },
    });
  } else if (environment.desiredCommitSha !== input.event.commitSha) {
    environment = await tx.previewEnvironment.update({
      where: { id: environment.id },
      data: { desiredCommitSha: input.event.commitSha, status: "ACTIVE", expiresAt },
      select: { id: true, desiredCommitSha: true, expiresAt: true },
    });
  } else {
    environment = await tx.previewEnvironment.update({
      where: { id: environment.id },
      data: { status: "ACTIVE", expiresAt },
      select: { id: true, desiredCommitSha: true, expiresAt: true },
    });
  }

  // A newer open/reopen cancels an unprocessed close request. The original
  // deletion outbox row remains an immutable fact; the worker will observe the
  // request status before deleting anything.
  await tx.environmentDeletionRequest.updateMany({
    where: {
      environmentId: environment.id,
      // A completed close request can be followed by a reopen. Keep the
      // durable request row, but make it non-actionable before the new
      // deployment recreates the preview namespace.
      status: { in: ["REQUESTED", "PROCESSING", "FAILED", "COMPLETED"] },
    },
    data: { status: "CANCELLED", completedAt: receivedAt, failureReason: null },
  });

  let deploymentId: string | undefined;
  if (environment.desiredCommitSha === input.event.commitSha) {
    const shouldDeploy =
      existingPullRequest === null ||
      existingPullRequest.state === "CLOSED" ||
      existingPullRequest.environment?.desiredCommitSha !== input.event.commitSha;
    if (shouldDeploy) {
      deploymentId = randomUUID();
      const eventId = randomUUID();
      await tx.deployment.create({
        data: {
          id: deploymentId,
          environmentId: environment.id,
          attempt: await nextAttempt(tx, environment.id),
          commitSha: input.event.commitSha,
          status: "QUEUED",
        },
      });
      faultInjector?.("before-outbox");
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: "deployment.requested.v1",
          aggregateType: "deployment",
          aggregateId: deploymentId,
          ...(input.traceParent === undefined ? {} : { traceParent: input.traceParent }),
          payload: {
            eventId,
            eventType: "deployment.requested.v1",
            occurredAt: receivedAt.toISOString(),
            deploymentId,
            environmentId: environment.id,
            projectId,
            installationId: input.event.installationId,
            repositoryFullName: input.event.repositoryFullName,
            pullRequestNumber: input.event.pullRequestNumber,
            commitSha: input.event.commitSha,
          },
        },
      });
    }
  }

  await tx.webhookDelivery.update({
    where: { id: deliveryRowId },
    data: { status: "PROCESSED", processedAt: receivedAt },
  });
  return {
    deliveryId: input.deliveryId,
    duplicate: false,
    stale: false,
    action: input.event.action,
    ...(deploymentId ? { deploymentId } : {}),
  };
}

async function processClosed(
  tx: TransactionClient,
  input: WebhookRepositoryInput,
  projectId: string,
  deliveryRowId: string,
  existingPullRequest: PullRequestRow | null,
  sourceUpdatedAt: Date,
  receivedAt: Date,
  faultInjector?: FaultInjector,
): Promise<WebhookProcessResult> {
  const pullRequest = existingPullRequest
    ? await tx.pullRequest.update({
        where: { id: existingPullRequest.id },
        data: {
          state: "CLOSED",
          sourceUpdatedAt,
          lastWebhookDeliveryId: input.deliveryId,
          lastWebhookEvent: input.event.action,
          lastWebhookAt: receivedAt,
          closedAt: sourceUpdatedAt,
          headSha: input.event.commitSha,
        },
        select: { id: true, number: true, environment: { select: { id: true } } },
      })
    : await tx.pullRequest.create({
        data: {
          projectId,
          number: input.event.pullRequestNumber,
          headSha: input.event.commitSha,
          state: "CLOSED",
          sourceUpdatedAt,
          lastWebhookDeliveryId: input.deliveryId,
          lastWebhookEvent: input.event.action,
          lastWebhookAt: receivedAt,
          closedAt: sourceUpdatedAt,
        },
        select: { id: true, number: true, environment: { select: { id: true } } },
      });

  const environment = pullRequest.environment;
  if (environment === null) {
    await tx.webhookDelivery.update({
      where: { id: deliveryRowId },
      data: { status: "PROCESSED", processedAt: receivedAt },
    });
    return {
      deliveryId: input.deliveryId,
      duplicate: false,
      stale: false,
      action: input.event.action,
    };
  }

  const requestKey = `environment:${environment.id}`;
  const existingRequest = await tx.environmentDeletionRequest.findUnique({
    where: { environmentId: environment.id },
    select: { id: true, status: true, reason: true },
  });
  let deletionRequestId: string | undefined;
  if (existingRequest === null) {
    deletionRequestId = randomUUID();
    await tx.environmentDeletionRequest.create({
      data: {
        id: deletionRequestId,
        environmentId: environment.id,
        requestKey,
        status: "REQUESTED",
        reason: "pull_request_closed",
        sourceUpdatedAt,
        sourceDeliveryId: input.deliveryId,
      },
    });
  } else if (
    existingRequest.status !== "REQUESTED" ||
    existingRequest.reason !== "pull_request_closed"
  ) {
    // A close after a reopen is a new deletion intent. Keep the request key
    // stable and make it actionable again; a fresh outbox fact is required.
    deletionRequestId = existingRequest.id;
    await tx.environmentDeletionRequest.update({
      where: { id: existingRequest.id },
      data: {
        status: "REQUESTED",
        reason: "pull_request_closed",
        completedAt: null,
        sourceUpdatedAt,
        sourceDeliveryId: input.deliveryId,
      },
    });
  } else {
    deletionRequestId = existingRequest.id;
  }

  if (
    existingRequest === null ||
    existingRequest.status !== "REQUESTED" ||
    existingRequest.reason !== "pull_request_closed"
  ) {
    const eventId = randomUUID();
    faultInjector?.("before-outbox");
    await tx.outboxEvent.create({
      data: {
        id: eventId,
        eventType: "environment.deletion-requested.v1",
        aggregateType: "environment",
        aggregateId: environment.id,
        payload: {
          eventId,
          eventType: "environment.deletion-requested.v1",
          occurredAt: receivedAt.toISOString(),
          environmentId: environment.id,
          sourceTimestamp: sourceUpdatedAt.toISOString(),
          projectId,
          pullRequestId: pullRequest.id,
          pullRequestNumber: pullRequest.number,
          repositoryId: input.event.repositoryId,
          repositoryFullName: input.event.repositoryFullName,
          installationId: input.event.installationId,
          reason: "pull_request_closed",
        },
      },
    });
  }

  await tx.webhookDelivery.update({
    where: { id: deliveryRowId },
    data: { status: "PROCESSED", processedAt: receivedAt },
  });
  return {
    deliveryId: input.deliveryId,
    duplicate: false,
    stale: false,
    action: input.event.action,
    deletionRequestId,
  };
}

type PullRequestRow = {
  id: string;
  number: number;
  state: string;
  sourceUpdatedAt: Date | null;
  environment: { id: string; desiredCommitSha: string } | null;
};

function duplicateResultOrThrow(
  existing: {
    deliveryId: string;
    eventName: string;
    payloadSha256: string;
    status: string;
  },
  input: WebhookRepositoryInput,
): WebhookProcessResult {
  if (existing.eventName !== input.eventName || existing.payloadSha256 !== input.payloadSha256) {
    throw new WebhookDeliveryConflictError();
  }
  return {
    deliveryId: input.deliveryId,
    duplicate: true,
    stale: existing.status === "IGNORED_STALE",
    action: input.event.action,
  };
}

function validateInput(input: WebhookRepositoryInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.deliveryId)) {
    throw new WebhookPayloadValidationError();
  }
  if (input.eventName !== "pull_request") throw new WebhookPayloadValidationError();
  if (!/^[0-9a-f]{64}$/i.test(input.payloadSha256)) throw new WebhookPayloadValidationError();
  if (input.traceParent !== undefined && !traceParentSchema.safeParse(input.traceParent).success) {
    throw new WebhookPayloadValidationError();
  }
  try {
    pullRequestEventSchema.parse(input.event);
  } catch {
    throw new WebhookPayloadValidationError();
  }
}

function parsePostgresBigInt(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > MAX_POSTGRES_BIGINT) throw new Error("out of range");
    return parsed;
  } catch {
    throw new WebhookPayloadValidationError();
  }
}

function boundedPreviewTtlSeconds(value: number | undefined): number {
  const ttl = value ?? DEFAULT_PREVIEW_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_PREVIEW_TTL_SECONDS) {
    throw new Error("preview TTL is invalid");
  }
  return ttl;
}

async function nextAttempt(tx: TransactionClient, environmentId: string): Promise<number> {
  const latest = await tx.deployment.findFirst({
    where: { environmentId },
    orderBy: { attempt: "desc" },
    select: { attempt: true },
  });
  return (latest?.attempt ?? 0) + 1;
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
