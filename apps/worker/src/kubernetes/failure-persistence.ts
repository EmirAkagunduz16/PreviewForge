import type { DeploymentStatus } from "@previewforge/contracts";
import type { DeploymentRepository } from "@previewforge/database";

type ActiveDeploymentStatus = Extract<DeploymentStatus, "DEPLOYING" | "WAITING_FOR_HEALTHCHECK">;

export type KubernetesFailure = {
  stage: "CONFIGURATION" | "KUBERNETES" | "ROLLOUT" | "HEALTHCHECK";
  code: string;
  message: string;
  retryable: boolean;
};

export type KubernetesFailurePersistence = Pick<
  DeploymentRepository,
  "supersedeIfStale" | "transition"
>;

export type PersistKubernetesFailureInput = {
  deployments: KubernetesFailurePersistence;
  deploymentId: string;
  commitSha: string;
  error: unknown;
};

export type PersistKubernetesFailureResult = "FAILED" | "SUPERSEDED";

const ACTIVE_STATUSES: readonly ActiveDeploymentStatus[] = ["DEPLOYING", "WAITING_FOR_HEALTHCHECK"];

/**
 * Maps worker/Kubernetes errors to durable, redacted deployment metadata.
 * Error messages and response bodies are intentionally never returned.
 */
export function classifyKubernetesFailure(error: unknown): KubernetesFailure {
  const code = readCode(error);

  if (isInvalidDuration(error)) {
    return {
      stage: "CONFIGURATION",
      code: "WORKER_DURATION_INVALID",
      message: "Worker duration configuration is invalid",
      retryable: false,
    };
  }

  if (isInvalidHealthCheckUrl(error)) {
    return {
      stage: "CONFIGURATION",
      code: "HEALTHCHECK_URL_INVALID",
      message: "Preview health-check URL configuration is invalid",
      retryable: false,
    };
  }

  if (code === "PREVIEW_OWNERSHIP_CONFLICT") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes preview ownership validation failed",
      retryable: false,
    };
  }

  if (code === "ENVIRONMENT_VARIABLE_DECRYPTION_FAILED") {
    return {
      stage: "CONFIGURATION",
      code,
      message: "Preview environment configuration could not be authenticated",
      retryable: false,
    };
  }

  if (code === "PREVIEW_SUPERSEDED") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Preview deployment was superseded",
      retryable: false,
    };
  }

  if (code === "ROLLOUT_TIMEOUT") {
    return {
      stage: "ROLLOUT",
      code,
      message: "Preview deployment rollout timed out",
      retryable: true,
    };
  }

  if (code === "ROLLOUT_FAILED") {
    return {
      stage: "ROLLOUT",
      code,
      message: "Preview deployment rollout failed",
      retryable: false,
    };
  }

  if (code === "HEALTHCHECK_TIMEOUT") {
    return {
      stage: "HEALTHCHECK",
      code,
      message: "Preview HTTP health-check timed out",
      retryable: true,
    };
  }

  if (code === "HEALTHCHECK_UNAVAILABLE") {
    return {
      stage: "HEALTHCHECK",
      code,
      message: "Preview HTTP health-check endpoint was temporarily unavailable",
      retryable: true,
    };
  }

  if (code === "HEALTHCHECK_FAILED") {
    return {
      stage: "HEALTHCHECK",
      code,
      message: "Preview HTTP health-check failed",
      retryable: false,
    };
  }

  if (code === "KUBERNETES_POLICY_REJECTED") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes policy rejected the preview resource",
      retryable: false,
    };
  }

  if (code === "KUBERNETES_API_REJECTED") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes API rejected the preview resource",
      retryable: false,
    };
  }

  if (code === "KUBERNETES_RATE_LIMITED") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes API rate limit was exceeded",
      retryable: true,
    };
  }

  if (code === "KUBERNETES_API_UNAVAILABLE") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes API is temporarily unavailable",
      retryable: true,
    };
  }

  if (code === "KUBERNETES_API_TIMEOUT") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes API mutation timed out",
      retryable: true,
    };
  }

  if (code === "KUBERNETES_NETWORK_ERROR") {
    return {
      stage: "KUBERNETES",
      code,
      message: "Kubernetes network request failed",
      retryable: true,
    };
  }

  const status = readStatusCode(error);
  if (status === 429) {
    return {
      stage: "KUBERNETES",
      code: "KUBERNETES_RATE_LIMITED",
      message: "Kubernetes API rate limit was exceeded",
      retryable: true,
    };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return {
      stage: "KUBERNETES",
      code: "KUBERNETES_API_UNAVAILABLE",
      message: "Kubernetes API is temporarily unavailable",
      retryable: true,
    };
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    return {
      stage: "KUBERNETES",
      code:
        status === 403 || isPolicyRejection(error)
          ? "KUBERNETES_POLICY_REJECTED"
          : "KUBERNETES_API_REJECTED",
      message:
        status === 403 || isPolicyRejection(error)
          ? "Kubernetes policy rejected the preview resource"
          : "Kubernetes API rejected the preview resource",
      retryable: false,
    };
  }

  if (isNetworkError(error)) {
    return {
      stage: "KUBERNETES",
      code: "KUBERNETES_NETWORK_ERROR",
      message: "Kubernetes network request failed",
      retryable: true,
    };
  }

  if (code === "ROLLOUT_API_FAILED") {
    return {
      stage: "ROLLOUT",
      code,
      message: "Kubernetes rollout query failed",
      retryable: true,
    };
  }

  return {
    stage: "KUBERNETES",
    code: "KUBERNETES_RECONCILIATION_FAILED",
    message: "Kubernetes preview reconciliation failed",
    retryable: true,
  };
}

/**
 * Records a Kubernetes failure against whichever active state is current.
 * The guarded transition prevents a stale worker from overwriting newer work.
 * If neither FAILED nor SUPERSEDED was applied, the original error is thrown
 * so the Kafka consumer does not acknowledge an unfinished deployment.
 */
export async function persistKubernetesFailure(
  input: PersistKubernetesFailureInput,
): Promise<PersistKubernetesFailureResult> {
  const failure = classifyKubernetesFailure(input.error);
  let expectedStatus: ActiveDeploymentStatus = "DEPLOYING";

  for (const status of ACTIVE_STATUSES) {
    if (status !== expectedStatus) continue;

    const transition = await input.deployments.transition({
      deploymentId: input.deploymentId,
      expectedStatus: status,
      to: "FAILED",
      expectedDesiredSha: input.commitSha,
      failure,
    });
    if (transition.applied) return "FAILED";

    if (transition.reason === "DESIRED_SHA_MISMATCH") {
      const superseded = await input.deployments.supersedeIfStale({
        deploymentId: input.deploymentId,
        expectedStatus: status,
        expectedCommitSha: input.commitSha,
      });
      if (superseded.applied) return "SUPERSEDED";

      if (
        superseded.reason === "EXPECTED_STATUS_MISMATCH" &&
        superseded.currentStatus === "WAITING_FOR_HEALTHCHECK"
      ) {
        expectedStatus = "WAITING_FOR_HEALTHCHECK";
        continue;
      }
      throw input.error;
    }

    if (
      transition.reason === "EXPECTED_STATUS_MISMATCH" &&
      transition.currentStatus === "WAITING_FOR_HEALTHCHECK"
    ) {
      expectedStatus = "WAITING_FOR_HEALTHCHECK";
      continue;
    }

    throw input.error;
  }

  throw input.error;
}

function readCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return error.code;
}

function readStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const direct = error.statusCode ?? error.status ?? error.code;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  for (const candidate of [error.response, error.body]) {
    if (!isRecord(candidate)) continue;
    const candidateStatus = candidate.statusCode ?? candidate.status ?? candidate.code;
    if (typeof candidateStatus === "number" && Number.isInteger(candidateStatus)) {
      return candidateStatus;
    }
  }
  return undefined;
}

function isPolicyRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const bodyReason = isRecord(error.body) ? error.body.reason : undefined;
  const responseBodyReason = isRecord(error.response)
    ? isRecord(error.response.body)
      ? error.response.body.reason
      : undefined
    : undefined;
  const reason = [
    error.reason,
    error.code,
    error.name,
    error.message,
    bodyReason,
    responseBodyReason,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return reason.includes("policy") || reason.includes("forbidden") || reason.includes("admission");
}

function isInvalidDuration(error: unknown): boolean {
  if (!isRecord(error) || typeof error.message !== "string") return false;
  return /invalid worker configuration: .*_[A-Z0-9]+_MS is invalid/i.test(error.message);
}

function isInvalidHealthCheckUrl(error: unknown): boolean {
  if (!isRecord(error) || typeof error.message !== "string") return false;
  return /healthcheck_url_template is invalid/i.test(error.message);
}

function isNetworkError(error: unknown): boolean {
  const code = readCode(error);
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    (isRecord(error) && error.retriable === true)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
