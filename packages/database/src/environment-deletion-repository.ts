import { randomUUID } from "node:crypto";
import {
  type EnvironmentDeletionRequested,
  environmentDeletionRequestedSchema,
} from "@previewforge/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

const DEFAULT_TRANSACTION_TIMEOUT_MS = 60_000;
const MAX_TRANSACTION_TIMEOUT_MS = 120_000;
const MAX_FAILURE_REASON_LENGTH = 512;
const DEFAULT_EXPIRY_SWEEP_LIMIT = 50;
const MAX_EXPIRY_SWEEP_LIMIT = 100;

export type EnvironmentDeletionStatus =
  | "REQUESTED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type EnvironmentDeletionResult =
  | { kind: "COMPLETED"; requestId: string }
  | { kind: "CANCELLED"; requestId: string; reason: "ENVIRONMENT_REOPENED" }
  | {
      kind: "SKIPPED";
      requestId?: string;
      reason: "MISSING_REQUEST" | "ALREADY_COMPLETED" | "ALREADY_CANCELLED" | "STALE_EVENT";
    }
  | {
      kind: "FAILED";
      requestId: string;
      code: string;
      retryable: boolean;
      message: string;
    };

export type EnvironmentDeletionRepositoryOptions = {
  transactionTimeoutMs?: number;
};

export type ExpiredEnvironmentSweepResult = {
  scanned: number;
  enqueued: number;
  skipped: number;
};

export type PreviewEnvironmentCleanupState = {
  projectId: string;
  environmentStatus: string;
  deletionStatus: string | null;
};

export type DeletePreviewNamespace = (environmentId: string) => Promise<void>;

export class EnvironmentDeletionValidationError extends Error {
  readonly code = "DELETION_REQUEST_INVALID";
  readonly retryable = false;

  constructor() {
    super("environment deletion request is invalid");
    this.name = "EnvironmentDeletionValidationError";
  }
}

/**
 * Owns the durable close request state and the only database boundary before
 * the worker invokes the ownership-safe Kubernetes namespace deletion seam.
 * The row lock deliberately spans the external delete call: a reopen either
 * cancels the request before the delete starts or waits until cleanup wins and
 * creates a fresh deployment through the normal webhook path.
 */
export class EnvironmentDeletionRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: EnvironmentDeletionRepositoryOptions = {},
  ) {}

  async findPreviewEnvironmentCleanupState(
    environmentId: string,
  ): Promise<PreviewEnvironmentCleanupState | null> {
    const environment = await this.prisma.previewEnvironment.findUnique({
      where: { id: environmentId },
      select: {
        projectId: true,
        status: true,
        deletionRequest: { select: { status: true } },
      },
    });
    if (environment === null) return null;
    return {
      projectId: environment.projectId,
      environmentStatus: environment.status,
      deletionStatus: environment.deletionRequest?.status ?? null,
    };
  }

  /**
   * Turn expired active environments into the same durable deletion command
   * consumed by PR-close cleanup. The environment row lock plus the stable
   * request identity makes concurrent sweeps safe without touching Kubernetes.
   */
  enqueueExpired(
    input: { now?: Date; limit?: number } = {},
  ): Promise<ExpiredEnvironmentSweepResult> {
    const limit = boundedSweepLimit(input.limit);
    const timeoutMs = boundedTransactionTimeout(this.options.transactionTimeoutMs);
    return this.prisma.$transaction(
      async (tx) => {
        const now = input.now ?? (await serverNow(tx));
        const candidates = await tx.$queryRaw<Array<ExpiredEnvironmentRow>>`
          SELECT
            environment.id AS "environmentId",
            environment.expires_at AS "expiresAt",
            environment.project_id AS "projectId",
            environment.pull_request_id AS "pullRequestId",
            pull_request.state AS "pullRequestState",
            pull_request.number AS "pullRequestNumber",
            project.github_repository_id AS "repositoryId",
            project.repository_full_name AS "repositoryFullName",
            installation.github_installation_id AS "installationId"
          FROM "preview_environments" AS environment
          JOIN "projects" AS project ON project.id = environment.project_id
          JOIN "installations" AS installation ON installation.id = project.installation_id
          LEFT JOIN "pull_requests" AS pull_request
            ON pull_request.id = environment.pull_request_id
          WHERE environment.status = 'ACTIVE'
            AND environment.expires_at IS NOT NULL
            AND environment.expires_at <= ${now}
          ORDER BY environment.expires_at ASC, environment.id ASC
          LIMIT ${limit}
          FOR UPDATE OF environment SKIP LOCKED
        `;

        let enqueued = 0;
        let skipped = 0;
        for (const candidate of candidates) {
          if (candidate.pullRequestState === "CLOSED") {
            skipped += 1;
            continue;
          }

          const expiresAt = candidate.expiresAt;
          if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
            skipped += 1;
            continue;
          }

          const existing = await tx.environmentDeletionRequest.findUnique({
            where: { environmentId: candidate.environmentId },
            select: { id: true, status: true, sourceUpdatedAt: true },
          });
          if (
            existing !== null &&
            (existing.status === "REQUESTED" ||
              existing.status === "PROCESSING" ||
              (existing.sourceUpdatedAt !== null && existing.sourceUpdatedAt >= expiresAt))
          ) {
            skipped += 1;
            continue;
          }

          const eventId = randomUUID();
          const sourceDeliveryId = `ttl:${candidate.environmentId}:${expiresAt.getTime()}`;
          if (existing === null) {
            await tx.environmentDeletionRequest.create({
              data: {
                id: randomUUID(),
                environmentId: candidate.environmentId,
                requestKey: `environment:${candidate.environmentId}`,
                status: "REQUESTED",
                reason: "ttl_expired",
                sourceUpdatedAt: expiresAt,
                sourceDeliveryId,
              },
            });
          } else {
            await tx.environmentDeletionRequest.update({
              where: { id: existing.id },
              data: {
                status: "REQUESTED",
                reason: "ttl_expired",
                completedAt: null,
                failureReason: null,
                sourceUpdatedAt: expiresAt,
                sourceDeliveryId,
              },
            });
          }

          await tx.outboxEvent.create({
            data: {
              id: eventId,
              eventType: "environment.deletion-requested.v1",
              aggregateType: "environment",
              aggregateId: candidate.environmentId,
              payload: {
                eventId,
                eventType: "environment.deletion-requested.v1",
                occurredAt: now.toISOString(),
                environmentId: candidate.environmentId,
                sourceTimestamp: expiresAt.toISOString(),
                projectId: candidate.projectId,
                ...(candidate.pullRequestId === null
                  ? {}
                  : { pullRequestId: candidate.pullRequestId }),
                ...(candidate.pullRequestNumber === null
                  ? {}
                  : { pullRequestNumber: candidate.pullRequestNumber }),
                ...(candidate.repositoryId === null
                  ? {}
                  : { repositoryId: candidate.repositoryId.toString() }),
                repositoryFullName: candidate.repositoryFullName,
                installationId: candidate.installationId.toString(),
                reason: "ttl_expired",
              },
            },
          });
          enqueued += 1;
        }

        return { scanned: candidates.length, enqueued, skipped };
      },
      { maxWait: 5_000, timeout: timeoutMs },
    );
  }

  process(input: {
    event: EnvironmentDeletionRequested;
    deleteNamespace: DeletePreviewNamespace;
  }): Promise<EnvironmentDeletionResult> {
    const event = parseEvent(input.event);
    const timeoutMs = boundedTransactionTimeout(this.options.transactionTimeoutMs);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM "environment_deletion_requests"
          WHERE environment_id = CAST(${event.environmentId} AS uuid)
          FOR UPDATE
        `;

        const request = await tx.environmentDeletionRequest.findUnique({
          where: { environmentId: event.environmentId },
          select: {
            id: true,
            status: true,
            sourceUpdatedAt: true,
            environment: {
              select: {
                projectId: true,
                pullRequestId: true,
                pullRequest: { select: { state: true } },
                project: {
                  select: {
                    githubRepositoryId: true,
                    repositoryFullName: true,
                    installation: { select: { githubInstallationId: true } },
                  },
                },
              },
            },
          },
        });

        if (request === null) return { kind: "SKIPPED", reason: "MISSING_REQUEST" };

        const status = parseStatus(request.status);
        if (status === "COMPLETED") {
          return { kind: "SKIPPED", requestId: request.id, reason: "ALREADY_COMPLETED" };
        }
        if (status === "CANCELLED") {
          return { kind: "SKIPPED", requestId: request.id, reason: "ALREADY_CANCELLED" };
        }

        if (
          request.sourceUpdatedAt !== null &&
          new Date(event.sourceTimestamp) < request.sourceUpdatedAt
        ) {
          return { kind: "SKIPPED", requestId: request.id, reason: "STALE_EVENT" };
        }

        const identityError = validateAggregateIdentity(event, request.environment);
        if (identityError !== undefined) {
          return persistFailure(tx, request.id, identityError);
        }

        if (request.environment.pullRequest?.state !== "CLOSED" && event.reason !== "ttl_expired") {
          const now = await serverNow(tx);
          await tx.environmentDeletionRequest.update({
            where: { id: request.id },
            data: { status: "CANCELLED", completedAt: now, failureReason: null },
          });
          return { kind: "CANCELLED", requestId: request.id, reason: "ENVIRONMENT_REOPENED" };
        }

        const now = await serverNow(tx);
        await tx.environmentDeletionRequest.update({
          where: { id: request.id },
          data: { status: "PROCESSING", completedAt: null, failureReason: null },
        });

        try {
          await input.deleteNamespace(event.environmentId);
        } catch (error) {
          const failure = classifyDeletionFailure(error);
          await tx.environmentDeletionRequest.update({
            where: { id: request.id },
            data: {
              status: "FAILED",
              completedAt: null,
              failureReason: boundedFailureReason(failure.message),
              updatedAt: now,
            },
          });
          return { kind: "FAILED", requestId: request.id, ...failure };
        }

        const completedAt = await serverNow(tx);
        await tx.environmentDeletionRequest.update({
          where: { id: request.id },
          data: { status: "COMPLETED", completedAt, failureReason: null },
        });
        return { kind: "COMPLETED", requestId: request.id };
      },
      { maxWait: 5_000, timeout: timeoutMs },
    );
  }
}

type TransactionClient = Prisma.TransactionClient;
type ExpiredEnvironmentRow = {
  environmentId: string;
  expiresAt: Date | null;
  projectId: string;
  pullRequestId: string | null;
  pullRequestState: string | null;
  pullRequestNumber: number | null;
  repositoryId: bigint | null;
  repositoryFullName: string;
  installationId: bigint;
};
type DeletionEnvironment = {
  projectId: string;
  pullRequestId: string | null;
  pullRequest: { state: string } | null;
  project: {
    githubRepositoryId: bigint | null;
    repositoryFullName: string;
    installation: { githubInstallationId: bigint };
  };
};

function parseEvent(value: EnvironmentDeletionRequested): EnvironmentDeletionRequested {
  const result = environmentDeletionRequestedSchema.safeParse(value);
  if (!result.success) throw new EnvironmentDeletionValidationError();
  return result.data;
}

function parseStatus(value: string): EnvironmentDeletionStatus {
  if (
    value === "REQUESTED" ||
    value === "PROCESSING" ||
    value === "COMPLETED" ||
    value === "FAILED" ||
    value === "CANCELLED"
  ) {
    return value;
  }
  throw new EnvironmentDeletionValidationError();
}

function validateAggregateIdentity(
  event: EnvironmentDeletionRequested,
  environment: DeletionEnvironment,
): { code: "DELETION_AGGREGATE_MISMATCH"; retryable: false; message: string } | undefined {
  if (event.projectId !== undefined && event.projectId !== environment.projectId) {
    return {
      code: "DELETION_AGGREGATE_MISMATCH",
      retryable: false,
      message: "Deletion request does not match the environment project",
    };
  }
  if (event.pullRequestId !== undefined && event.pullRequestId !== environment.pullRequestId) {
    return {
      code: "DELETION_AGGREGATE_MISMATCH",
      retryable: false,
      message: "Deletion request does not match the environment pull request",
    };
  }
  if (
    event.repositoryId !== undefined &&
    event.repositoryId !== environment.project.githubRepositoryId?.toString()
  ) {
    return {
      code: "DELETION_AGGREGATE_MISMATCH",
      retryable: false,
      message: "Deletion request does not match the environment repository",
    };
  }
  if (
    event.repositoryFullName !== undefined &&
    event.repositoryFullName !== environment.project.repositoryFullName
  ) {
    return {
      code: "DELETION_AGGREGATE_MISMATCH",
      retryable: false,
      message: "Deletion request does not match the environment repository",
    };
  }
  if (
    event.installationId !== undefined &&
    event.installationId !== environment.project.installation.githubInstallationId.toString()
  ) {
    return {
      code: "DELETION_AGGREGATE_MISMATCH",
      retryable: false,
      message: "Deletion request does not match the environment installation",
    };
  }
  return undefined;
}

async function persistFailure(
  tx: TransactionClient,
  requestId: string,
  failure: { code: string; retryable: false; message: string },
): Promise<Extract<EnvironmentDeletionResult, { kind: "FAILED" }>> {
  await tx.environmentDeletionRequest.update({
    where: { id: requestId },
    data: {
      status: "FAILED",
      completedAt: null,
      failureReason: boundedFailureReason(failure.message),
    },
  });
  return { kind: "FAILED", requestId, ...failure };
}

function classifyDeletionFailure(error: unknown): {
  code: string;
  retryable: boolean;
  message: string;
} {
  if (isRecord(error) && error.code === "PREVIEW_OWNERSHIP_CONFLICT") {
    return {
      code: "PREVIEW_OWNERSHIP_CONFLICT",
      retryable: false,
      message: "Preview namespace ownership conflict",
    };
  }
  if (isRecord(error) && error.code === "KUBERNETES_API_TIMEOUT") {
    return {
      code: "KUBERNETES_API_TIMEOUT",
      retryable: true,
      message: "Kubernetes API timed out during preview namespace deletion",
    };
  }
  return {
    code: "KUBERNETES_DELETE_FAILED",
    retryable: true,
    message: "Preview namespace deletion failed",
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

function boundedTransactionTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > MAX_TRANSACTION_TIMEOUT_MS) {
    throw new Error("environment deletion transaction timeout is invalid");
  }
  return timeout;
}

function boundedSweepLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_EXPIRY_SWEEP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPIRY_SWEEP_LIMIT) {
    throw new Error("expired environment sweep limit is invalid");
  }
  return limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedFailureReason(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .slice(0, MAX_FAILURE_REASON_LENGTH);
}
