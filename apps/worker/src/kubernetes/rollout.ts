import type { DeploymentTransitionResult } from "@previewforge/database";
import type { KubernetesResourceClient } from "./reconciler.js";
import type { KubernetesResource } from "./resource-renderer.js";

export const DEFAULT_ROLLOUT_TIMEOUT_MS = 120_000;
export const DEFAULT_ROLLOUT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 5_000;

export type PreviewRolloutInput = {
  deploymentId: string;
  environmentId: string;
  commitSha: string;
  namespace: string;
  deploymentName: string;
  hostname: string;
  healthPath: string;
  healthCheckUrl?: string;
  rolloutTimeoutMs?: number;
  pollIntervalMs?: number;
  healthCheckTimeoutMs?: number;
};

export type PreviewRolloutDependencies = {
  kubernetes: Pick<KubernetesResourceClient, "get">;
  deployments: PreviewRolloutDeploymentStore;
  healthCheck?: (url: string, timeoutMs: number) => Promise<HealthCheckResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export type PreviewRolloutDeploymentStore = {
  isDesired(deploymentId: string, desiredCommitSha: string): Promise<boolean>;
  supersedeIfStale(input: {
    deploymentId: string;
    expectedStatus: "DEPLOYING" | "WAITING_FOR_HEALTHCHECK";
    expectedCommitSha: string;
  }): Promise<DeploymentTransitionResult>;
  transition(input: {
    deploymentId: string;
    expectedStatus: "DEPLOYING" | "WAITING_FOR_HEALTHCHECK";
    to: "WAITING_FOR_HEALTHCHECK" | "READY" | "FAILED";
    expectedDesiredSha: string;
    imageDigest?: string;
    failure?: {
      stage: string;
      code: string;
      message: string;
      retryable: boolean;
    };
  }): Promise<DeploymentTransitionResult>;
};

export type HealthCheckResult =
  | { ok: true; statusCode: number }
  | {
      ok: false;
      code: "HEALTHCHECK_FAILED" | "HEALTHCHECK_TIMEOUT" | "HEALTHCHECK_UNAVAILABLE";
    };

export type PreviewRolloutResult =
  | { kind: "READY"; transition: DeploymentTransitionResult }
  | { kind: "SUPERSEDED"; transition: DeploymentTransitionResult }
  | { kind: "FAILED"; transition: DeploymentTransitionResult };

export class RolloutTimeoutError extends Error {
  readonly code = "ROLLOUT_TIMEOUT";

  constructor() {
    super("Kubernetes deployment did not become available before the rollout deadline");
    this.name = "RolloutTimeoutError";
  }
}

export class RolloutFailedError extends Error {
  readonly code = "ROLLOUT_FAILED";

  constructor() {
    super("Kubernetes deployment reported a failed rollout");
    this.name = "RolloutFailedError";
  }
}

export class RolloutSupersededError extends Error {
  readonly code = "PREVIEW_SUPERSEDED";

  constructor() {
    super("preview deployment was superseded during rollout");
    this.name = "RolloutSupersededError";
  }
}

export async function runPreviewRollout(
  input: PreviewRolloutInput,
  dependencies: PreviewRolloutDependencies,
): Promise<PreviewRolloutResult> {
  const rolloutTimeoutMs = boundedDuration(
    input.rolloutTimeoutMs ?? DEFAULT_ROLLOUT_TIMEOUT_MS,
    "rollout timeout",
  );
  const pollIntervalMs = boundedDuration(
    input.pollIntervalMs ?? DEFAULT_ROLLOUT_POLL_INTERVAL_MS,
    "rollout poll interval",
  );
  const healthCheckTimeoutMs = boundedDuration(
    input.healthCheckTimeoutMs ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS,
    "health-check timeout",
  );
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const deadline = now() + rolloutTimeoutMs;

  try {
    await waitForAvailable(
      input,
      dependencies.kubernetes,
      deadline,
      pollIntervalMs,
      now,
      sleep,
      () => dependencies.deployments.isDesired(input.deploymentId, input.commitSha),
    );
  } catch (error) {
    if (error instanceof RolloutSupersededError) return supersede(input, dependencies);
    return failRollout(input, dependencies, classifyRolloutFailure(error));
  }

  if (!(await dependencies.deployments.isDesired(input.deploymentId, input.commitSha))) {
    return supersede(input, dependencies);
  }

  const healthUrl = input.healthCheckUrl ?? `http://${input.hostname}${input.healthPath}`;
  const healthCheck = dependencies.healthCheck ?? httpHealthCheck;
  try {
    const health = await waitForHealthCheck(
      healthUrl,
      healthCheck,
      healthCheckTimeoutMs,
      deadline,
      pollIntervalMs,
      now,
      sleep,
      () => dependencies.deployments.isDesired(input.deploymentId, input.commitSha),
    );
    if (!health.ok) return failHealth(input, dependencies, health.code);
    if (!(await dependencies.deployments.isDesired(input.deploymentId, input.commitSha))) {
      return supersede(input, dependencies);
    }
  } catch (error) {
    if (error instanceof RolloutSupersededError) return supersede(input, dependencies);
    throw error;
  }

  if (now() > deadline) return failHealth(input, dependencies, "HEALTHCHECK_TIMEOUT");

  const ready = await dependencies.deployments.transition({
    deploymentId: input.deploymentId,
    expectedStatus: "WAITING_FOR_HEALTHCHECK",
    to: "READY",
    expectedDesiredSha: input.commitSha,
  });
  if (ready.applied) return { kind: "READY", transition: ready };
  if (ready.reason === "DESIRED_SHA_MISMATCH") return supersede(input, dependencies);
  throw new Error(`deployment READY transition failed: ${ready.reason}`);
}

async function waitForHealthCheck(
  url: string,
  healthCheck: (url: string, timeoutMs: number) => Promise<HealthCheckResult>,
  healthCheckTimeoutMs: number,
  deadline: number,
  pollIntervalMs: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  isDesired: () => Promise<boolean>,
): Promise<HealthCheckResult> {
  let lastFailure: HealthCheckResult | undefined;

  while (true) {
    if (!(await isDesired())) throw new RolloutSupersededError();
    const remainingBeforeProbe = deadline - now();
    if (remainingBeforeProbe <= 0) {
      return lastFailure ?? { ok: false, code: "HEALTHCHECK_TIMEOUT" };
    }

    let health: HealthCheckResult;
    try {
      health = await healthCheck(url, Math.min(healthCheckTimeoutMs, remainingBeforeProbe));
    } catch {
      // A custom health-check may use a different transport and throw on a
      // transient connection failure. Keep that distinct from an observed
      // HTTP response so the durable retryability flag remains correct.
      health = { ok: false, code: "HEALTHCHECK_UNAVAILABLE" };
    }
    if (now() > deadline) return { ok: false, code: "HEALTHCHECK_TIMEOUT" };
    if (health.ok) return health;
    lastFailure = health;

    // A desired-SHA change during a failed probe must supersede before another
    // request or a durable health failure can be recorded for stale work.
    if (!(await isDesired())) throw new RolloutSupersededError();
    const remaining = deadline - now();
    if (remaining <= 0) return health;
    const delay = Math.min(Math.max(pollIntervalMs, 1), remaining);
    const beforeSleep = now();
    await sleep(delay);
    // A custom clock/sleeper used by a caller must not be able to turn a
    // bounded retry into a busy loop when it makes no observable progress.
    if (now() <= beforeSleep) return health;
  }
}

async function waitForAvailable(
  input: PreviewRolloutInput,
  kubernetes: Pick<KubernetesResourceClient, "get">,
  deadline: number,
  pollIntervalMs: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  isDesired: () => Promise<boolean>,
): Promise<void> {
  while (now() <= deadline) {
    if (!(await isDesired())) throw new RolloutSupersededError();
    const deployment = await getDeploymentUntilDeadline(
      kubernetes,
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: input.deploymentName,
        namespace: input.namespace,
      },
      deadline,
      now,
    );
    if (deployment !== null) {
      const status = deployment.status as DeploymentStatus | undefined;
      if (status !== undefined && hasFailed(status)) throw new RolloutFailedError();
      if (isAvailable(deployment)) return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new RolloutTimeoutError();
}

async function getDeploymentUntilDeadline(
  kubernetes: Pick<KubernetesResourceClient, "get">,
  identity: Parameters<KubernetesResourceClient["get"]>[0],
  deadline: number,
  now: () => number,
): ReturnType<KubernetesResourceClient["get"]> {
  const remaining = deadline - now();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new RolloutTimeoutError()), Math.max(remaining, 0));
  });
  try {
    // Kubernetes client-node 2.x does not expose an AbortSignal on this
    // adapter. The race bounds the worker control path; an already-started
    // SDK request may still settle in the background.
    return await Promise.race([kubernetes.get(identity), deadlineReached]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isAvailable(resource: KubernetesResource): boolean {
  const spec = resource.spec as { replicas?: number } | undefined;
  const status = resource.status as DeploymentStatus | undefined;
  const metadata = resource.metadata as { generation?: number };
  const replicas = spec?.replicas ?? 1;
  return (
    (metadata.generation === undefined ||
      (status?.observedGeneration ?? 0) >= metadata.generation) &&
    (status?.availableReplicas ?? 0) >= replicas &&
    (status?.updatedReplicas ?? 0) >= replicas &&
    (status?.readyReplicas ?? 0) >= replicas
  );
}

function hasFailed(status: DeploymentStatus): boolean {
  return (
    status.conditions?.some(
      (condition) =>
        condition.type === "Progressing" &&
        condition.status === "False" &&
        condition.reason === "ProgressDeadlineExceeded",
    ) === true
  );
}

async function failRollout(
  input: PreviewRolloutInput,
  dependencies: PreviewRolloutDependencies,
  failure: { code: string; retryable: boolean },
): Promise<PreviewRolloutResult> {
  const transition = await dependencies.deployments.transition({
    deploymentId: input.deploymentId,
    expectedStatus: "WAITING_FOR_HEALTHCHECK",
    to: "FAILED",
    expectedDesiredSha: input.commitSha,
    failure: {
      stage: "ROLLOUT",
      code: failure.code,
      message: "Preview deployment rollout failed",
      retryable: failure.retryable,
    },
  });
  if (transition.applied) return { kind: "FAILED", transition };
  if (transition.reason === "DESIRED_SHA_MISMATCH") return supersede(input, dependencies);
  throw new Error(`deployment rollout failure transition failed: ${transition.reason}`);
}

async function failHealth(
  input: PreviewRolloutInput,
  dependencies: PreviewRolloutDependencies,
  code: "HEALTHCHECK_FAILED" | "HEALTHCHECK_TIMEOUT" | "HEALTHCHECK_UNAVAILABLE",
): Promise<PreviewRolloutResult> {
  const transition = await dependencies.deployments.transition({
    deploymentId: input.deploymentId,
    expectedStatus: "WAITING_FOR_HEALTHCHECK",
    to: "FAILED",
    expectedDesiredSha: input.commitSha,
    failure: {
      stage: "HEALTHCHECK",
      code,
      message: "Preview HTTP health-check failed",
      retryable: code !== "HEALTHCHECK_FAILED",
    },
  });
  if (transition.applied) return { kind: "FAILED", transition };
  if (transition.reason === "DESIRED_SHA_MISMATCH") return supersede(input, dependencies);
  throw new Error(`deployment health-check failure transition failed: ${transition.reason}`);
}

async function supersede(
  input: PreviewRolloutInput,
  dependencies: PreviewRolloutDependencies,
): Promise<PreviewRolloutResult> {
  const transition = await dependencies.deployments.supersedeIfStale({
    deploymentId: input.deploymentId,
    expectedStatus: "WAITING_FOR_HEALTHCHECK",
    expectedCommitSha: input.commitSha,
  });
  return { kind: "SUPERSEDED", transition };
}

function classifyRolloutFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof RolloutFailedError) return { code: error.code, retryable: false };
  if (error instanceof RolloutTimeoutError) return { code: error.code, retryable: true };
  return { code: "ROLLOUT_API_FAILED", retryable: true };
}

export function resolveHealthCheckUrl(
  template: string | undefined,
  hostname: string,
  healthPath: string,
): string | undefined {
  if (template === undefined || template.trim() === "") return undefined;
  const value = template.replaceAll("{hostname}", hostname).replaceAll("{path}", healthPath);
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error("PREVIEWFORGE_HEALTHCHECK_URL_TEMPLATE is invalid");
  }
}

export async function httpHealthCheck(url: string, timeoutMs: number): Promise<HealthCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    return response.ok
      ? { ok: true, statusCode: response.status }
      : { ok: false, code: "HEALTHCHECK_FAILED" };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof DOMException && error.name === "AbortError"
          ? "HEALTHCHECK_TIMEOUT"
          : "HEALTHCHECK_UNAVAILABLE",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60 * 1_000) {
    throw new Error(`${label} is invalid`);
  }
  return Math.floor(value);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type DeploymentStatus = {
  observedGeneration?: number;
  availableReplicas?: number;
  updatedReplicas?: number;
  readyReplicas?: number;
  conditions?: Array<{ type?: string; status?: string; reason?: string }>;
};
