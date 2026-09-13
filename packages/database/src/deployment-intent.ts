import { type DeploymentRequested, deploymentRequestedSchema } from "@previewforge/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";

/** The only fields that may cross the deployment.requested.v1 boundary. */
export type DeploymentRequestedPayload = DeploymentRequested;

export class DeploymentRequestedValidationError extends Error {
  readonly code = "INVALID_DEPLOYMENT_REQUESTED_PAYLOAD";

  constructor() {
    super("deployment.requested.v1 payload is invalid");
    this.name = "DeploymentRequestedValidationError";
  }
}

export class DeploymentIntentConflictError extends Error {
  readonly code = "DEPLOYMENT_INTENT_CONFLICT";

  constructor() {
    super("deployment intent identity is already associated with a different command");
    this.name = "DeploymentIntentConflictError";
  }
}

/**
 * Validate and normalize the external event before any database call.
 * Unknown fields are intentionally discarded so an accidental secret cannot
 * be copied into the durable event payload.
 */
export function parseDeploymentRequestedPayload(value: unknown): DeploymentRequestedPayload {
  const result = deploymentRequestedSchema.safeParse(value);
  if (!result.success) {
    throw new DeploymentRequestedValidationError();
  }

  return result.data;
}

export interface DeploymentIntentResult {
  readonly created: boolean;
  readonly deployment: Prisma.DeploymentGetPayload<object>;
  readonly outboxEvent: Prisma.OutboxEventGetPayload<object>;
}

type DatabaseClient = PrismaClient;
type IntentReadClient = Pick<PrismaClient, "deployment" | "outboxEvent">;
type DeploymentIntentEnvironment = Prisma.PreviewEnvironmentGetPayload<{
  select: {
    projectId: true;
    desiredCommitSha: true;
    project: {
      select: {
        repositoryFullName: true;
        installation: { select: { githubInstallationId: true } };
      };
    };
  };
}>;

// Serializable transactions can all observe the same snapshot when a burst
// of duplicate deliveries starts together. Give the losing transactions a
// bounded, jittered retry window so they can observe the committed pair.
const MAX_TRANSACTION_RETRIES = 8;
const INITIAL_RETRY_DELAY_MS = 5;
const MAX_RETRY_DELAY_MS = 100;

function retryDelayMs(retry: number): number {
  const exponentialDelay = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** retry);
  const jitter = Math.floor(Math.random() * exponentialDelay);
  return exponentialDelay + jitter;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isWriteConflictError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function isTransactionWriteConflictError(error: unknown): boolean {
  if (isWriteConflictError(error)) {
    return true;
  }

  return (
    hasTransactionWriteConflictFields(error) ||
    (isRecord(error) && hasTransactionWriteConflictFields(error.cause))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasTransactionWriteConflictFields(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.kind === "TransactionWriteConflict" &&
    (value.originalCode === "40001" || value.originalCode === "40P01")
  );
}

function isDeploymentAttemptUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("environment_id") && target.includes("attempt");
  }

  return (
    typeof target === "string" && target.includes("environment_id") && target.includes("attempt")
  );
}

function payloadMatches(value: Prisma.JsonValue, expected: DeploymentRequestedPayload): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  const candidateKeys = Object.keys(candidate);

  // Compare the normalized allow-list exactly. This prevents an existing row
  // with the same identity fields plus an untrusted extra field from being
  // mistaken for the same command.
  return (
    candidateKeys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) =>
        Object.hasOwn(candidate, key) &&
        candidate[key] === expected[key as keyof DeploymentRequestedPayload],
    )
  );
}

export class DeploymentIntentRepository {
  constructor(private readonly prisma: DatabaseClient) {}

  private async findIdempotentResult(
    client: IntentReadClient,
    payload: DeploymentRequestedPayload,
  ): Promise<DeploymentIntentResult | undefined> {
    const [deployment, outboxEvent] = await Promise.all([
      client.deployment.findUnique({ where: { id: payload.deploymentId } }),
      client.outboxEvent.findUnique({ where: { id: payload.eventId } }),
    ]);

    if (
      deployment !== null &&
      deployment.environmentId === payload.environmentId &&
      deployment.commitSha === payload.commitSha &&
      outboxEvent !== null &&
      outboxEvent.eventType === payload.eventType &&
      outboxEvent.aggregateType === "deployment" &&
      outboxEvent.aggregateId === payload.deploymentId &&
      payloadMatches(outboxEvent.payload, payload)
    ) {
      return { created: false, deployment, outboxEvent };
    }

    return undefined;
  }

  /**
   * Persist a queued deployment and deployment.requested.v1 event atomically.
   * The payload event ID and deployment ID are stable identities supplied by
   * the command producer, making retries safe under at-least-once delivery.
   */
  async createDeploymentIntent(rawPayload: unknown): Promise<DeploymentIntentResult> {
    const payload = parseDeploymentRequestedPayload(rawPayload);

    for (let retry = 0; retry <= MAX_TRANSACTION_RETRIES; retry += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const existing = await this.findIdempotentResult(tx, payload);
            if (existing !== undefined) {
              return existing;
            }

            const environment = await tx.previewEnvironment.findUnique({
              where: { id: payload.environmentId },
              select: {
                projectId: true,
                desiredCommitSha: true,
                project: {
                  select: {
                    repositoryFullName: true,
                    installation: { select: { githubInstallationId: true } },
                  },
                },
              },
            });

            if (
              environment === null ||
              environment.projectId !== payload.projectId ||
              environment.desiredCommitSha !== payload.commitSha ||
              !environmentMatchesPayload(environment, payload)
            ) {
              throw new DeploymentIntentConflictError();
            }

            const latest = await tx.deployment.findFirst({
              where: { environmentId: payload.environmentId },
              orderBy: { attempt: "desc" },
              select: { attempt: true },
            });
            const attempt = (latest?.attempt ?? 0) + 1;

            const deployment = await tx.deployment.create({
              data: {
                id: payload.deploymentId,
                environmentId: payload.environmentId,
                attempt,
                commitSha: payload.commitSha,
                status: "QUEUED",
              },
            });

            // eventId is the outbox primary key: deterministic across retries.
            const outboxEvent = await tx.outboxEvent.create({
              data: {
                id: payload.eventId,
                eventType: payload.eventType,
                aggregateType: "deployment",
                aggregateId: payload.deploymentId,
                payload: payload as unknown as Prisma.InputJsonValue,
              },
            });

            return { created: true, deployment, outboxEvent };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const retryableRace =
          isTransactionWriteConflictError(error) || isDeploymentAttemptUniqueConstraint(error);
        if (retryableRace) {
          if (retry < MAX_TRANSACTION_RETRIES) {
            await wait(retryDelayMs(retry));
            continue;
          }
        }

        if (isUniqueConstraintError(error)) {
          // A P2002 aborts the transaction; read the committed pair using the
          // root client only after rollback. This is safe for concurrent retries.
          const existing = await this.findIdempotentResult(this.prisma, payload);
          if (existing !== undefined) {
            return existing;
          }

          throw new DeploymentIntentConflictError();
        }

        throw error;
      }
    }

    throw new Error("unreachable");
  }
}

function environmentMatchesPayload(
  environment: DeploymentIntentEnvironment,
  payload: DeploymentRequestedPayload,
): boolean {
  return (
    environment.project.repositoryFullName === payload.repositoryFullName &&
    environment.project.installation.githubInstallationId === BigInt(payload.installationId)
  );
}

export async function createDeploymentIntent(
  prisma: PrismaClient,
  rawPayload: unknown,
): Promise<DeploymentIntentResult> {
  return new DeploymentIntentRepository(prisma).createDeploymentIntent(rawPayload);
}
