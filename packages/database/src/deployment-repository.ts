import { randomUUID } from "node:crypto";
import {
  canTransitionDeployment,
  type DeploymentStatus,
  deploymentStatusSchema,
} from "@previewforge/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

const MAX_FAILURE_MESSAGE_LENGTH = 2_000;

export type DeploymentFailure = {
  stage: string;
  code: string;
  /** A message that is safe to persist and show to an operator. */
  message: string;
  retryable: boolean;
};

export type DeploymentTransitionInput = {
  deploymentId: string;
  expectedStatus: DeploymentStatus;
  to: DeploymentStatus;
  /** The desired SHA captured by the caller and required for every transition. */
  expectedDesiredSha: string;
  failure?: DeploymentFailure;
  occurredAt?: Date;
};

export type DeploymentRecord = {
  id: string;
  environmentId: string;
  attempt: number;
  commitSha: string;
  status: DeploymentStatus;
  failureStage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  failureRetryable: boolean | null;
  checkRunId: string | null;
  imageDigest: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DeploymentTransitionNoopReason =
  | "NOT_FOUND"
  | "EXPECTED_STATUS_MISMATCH"
  | "DESIRED_SHA_MISMATCH"
  | "ILLEGAL_TRANSITION"
  | "TERMINAL";

export type DeploymentTransitionResult =
  | { applied: true; deployment: DeploymentRecord; outboxEventId: string; eventType: string }
  | {
      applied: false;
      reason: DeploymentTransitionNoopReason;
      currentStatus?: DeploymentStatus;
    };

export class DeploymentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentTransitionError";
  }
}

type DeploymentRow = Prisma.DeploymentGetPayload<object>;
type TransactionClient = Prisma.TransactionClient;
type DeploymentGuardRow = Prisma.DeploymentGetPayload<{
  select: {
    status: true;
    commitSha: true;
    environment: { select: { desiredCommitSha: true } };
  };
}>;

/**
 * Persists deployment state changes. The status update and its event are one
 * transaction; a caller can safely retry a command after a process crash.
 */
export class DeploymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  transition(input: DeploymentTransitionInput): Promise<DeploymentTransitionResult> {
    return transitionDeployment(this.prisma, input);
  }

  transitionDeployment(input: DeploymentTransitionInput): Promise<DeploymentTransitionResult> {
    return this.transition(input);
  }
}

export async function transitionDeployment(
  prisma: PrismaClient,
  input: DeploymentTransitionInput,
): Promise<DeploymentTransitionResult> {
  validateInput(input);
  const occurredAt = input.occurredAt ?? new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await updateDeploymentWithGuards(tx, input, occurredAt);
    const row = updated[0];
    if (row) {
      const deployment = toDeploymentRecord(row);
      const outboxEventId = randomUUID();
      const eventType = eventTypeFor(input.to);
      await tx.outboxEvent.create({
        data: {
          id: outboxEventId,
          eventType,
          aggregateType: "deployment",
          aggregateId: deployment.id,
          payload: transitionPayload(deployment, input, eventType, outboxEventId, occurredAt),
        },
      });

      return { applied: true, deployment, outboxEventId, eventType };
    }

    const guard = await readGuard(tx, input.deploymentId);
    if (!guard) {
      return { applied: false, reason: "NOT_FOUND" };
    }

    const currentStatus = deploymentStatusSchema.parse(guard.status);
    if (isTerminal(currentStatus) && !(currentStatus === "READY" && input.to === "SUPERSEDED")) {
      return { applied: false, reason: "TERMINAL", currentStatus };
    }
    if (currentStatus !== input.expectedStatus) {
      return { applied: false, reason: "EXPECTED_STATUS_MISMATCH", currentStatus };
    }
    const desiredShaGuardSatisfied =
      input.to === "SUPERSEDED"
        ? guard.commitSha !== guard.environment.desiredCommitSha
        : guard.commitSha === guard.environment.desiredCommitSha;
    if (
      !desiredShaGuardSatisfied ||
      guard.environment.desiredCommitSha !== input.expectedDesiredSha
    ) {
      return { applied: false, reason: "DESIRED_SHA_MISMATCH", currentStatus };
    }

    // This should only be reachable if the database changes between the
    // guarded UPDATE and this diagnostic read, but keeps the result explicit.
    return { applied: false, reason: "EXPECTED_STATUS_MISMATCH", currentStatus };
  });
}

function validateInput(input: DeploymentTransitionInput): void {
  if (typeof input.expectedDesiredSha !== "string" || input.expectedDesiredSha.trim() === "") {
    throw new DeploymentTransitionError("expectedDesiredSha is required");
  }

  const expectedStatus = deploymentStatusSchema.safeParse(input.expectedStatus);
  const toStatus = deploymentStatusSchema.safeParse(input.to);
  if (!expectedStatus.success || !toStatus.success) {
    throw new DeploymentTransitionError("deployment transition contains an unknown status");
  }

  if (!canTransitionDeployment(expectedStatus.data, toStatus.data)) {
    if (isTerminal(expectedStatus.data)) {
      throw new DeploymentTransitionError(
        `terminal deployment ${input.expectedStatus} cannot transition to ${input.to}`,
      );
    }
    throw new DeploymentTransitionError(
      `deployment transition ${input.expectedStatus} -> ${input.to} is not allowed`,
    );
  }

  if (input.to === "FAILED") {
    if (
      input.failure === null ||
      typeof input.failure !== "object" ||
      typeof input.failure.stage !== "string" ||
      typeof input.failure.code !== "string" ||
      typeof input.failure.message !== "string" ||
      typeof input.failure.retryable !== "boolean"
    ) {
      throw new DeploymentTransitionError("FAILED transitions require failure details");
    }
    if (input.failure.stage.trim().length === 0) {
      throw new DeploymentTransitionError("failure stage must not be empty");
    }
    if (input.failure.code.trim().length === 0) {
      throw new DeploymentTransitionError("failure code must not be empty");
    }
    if (input.failure.message.trim().length === 0) {
      throw new DeploymentTransitionError("failure message must not be empty");
    }
    if (input.failure.message.length > MAX_FAILURE_MESSAGE_LENGTH) {
      throw new DeploymentTransitionError("failure message exceeds the 2000 character limit");
    }
  } else if (input.failure) {
    throw new DeploymentTransitionError("failure details are only valid for FAILED transitions");
  }
}

function isTerminal(status: DeploymentStatus): boolean {
  return (
    status === "READY" || status === "FAILED" || status === "SUPERSEDED" || status === "CANCELLED"
  );
}

async function updateDeploymentWithGuards(
  tx: TransactionClient,
  input: DeploymentTransitionInput,
  occurredAt: Date,
): Promise<DeploymentRow[]> {
  const failure = input.failure;

  return tx.deployment.updateManyAndReturn({
    where: {
      id: input.deploymentId,
      status: input.expectedStatus,
      environment: { desiredCommitSha: input.expectedDesiredSha },
      // A normal transition can only run for the desired deployment. A
      // SUPERSEDED transition is the exception: its desired SHA must now be
      // different from the deployment's captured commit SHA.
      commitSha:
        input.to === "SUPERSEDED" ? { not: input.expectedDesiredSha } : input.expectedDesiredSha,
    },
    data: {
      status: input.to,
      failureStage: failure?.stage ?? null,
      failureCode: failure?.code ?? null,
      failureMessage: failure ? redactFailureMessage(failure.message) : null,
      failureRetryable: failure?.retryable ?? null,
      updatedAt: occurredAt,
      ...(input.to === "CLONING" ? { startedAt: occurredAt } : {}),
      // READY is terminal but can be superseded by a newer desired commit;
      // preserve the original completion time for that transition.
      ...(isTerminal(input.to) && input.expectedStatus !== "READY"
        ? { finishedAt: occurredAt }
        : {}),
    },
  });
}

async function readGuard(
  tx: TransactionClient,
  deploymentId: string,
): Promise<DeploymentGuardRow | null> {
  return tx.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      status: true,
      commitSha: true,
      environment: { select: { desiredCommitSha: true } },
    },
  });
}

function eventTypeFor(status: DeploymentStatus): string {
  if (status === "READY") return "deployment.ready.v1";
  if (status === "FAILED") return "deployment.failed.v1";
  return "deployment.stage-changed.v1";
}

function transitionPayload(
  deployment: DeploymentRecord,
  input: DeploymentTransitionInput,
  eventType: string,
  eventId: string,
  occurredAt: Date,
): Prisma.InputJsonObject {
  const payload = {
    eventId,
    eventType,
    occurredAt: occurredAt.toISOString(),
    deploymentId: deployment.id,
    environmentId: deployment.environmentId,
    commitSha: deployment.commitSha,
    fromStatus: input.expectedStatus,
    toStatus: input.to,
    ...(input.failure
      ? {
          failure: {
            stage: input.failure.stage,
            code: input.failure.code,
            message: redactFailureMessage(input.failure.message),
            retryable: input.failure.retryable,
          },
        }
      : {}),
  } satisfies Prisma.InputJsonObject;
  return payload;
}

function redactFailureMessage(message: string): string {
  return message
    .trim()
    .replace(/(ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization\s*:\s*)?(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[REDACTED]@[REDACTED]")
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function toDeploymentRecord(row: DeploymentRow): DeploymentRecord {
  return {
    ...row,
    status: deploymentStatusSchema.parse(row.status),
  };
}
