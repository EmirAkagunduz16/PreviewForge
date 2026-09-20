import type { DeploymentTransitionResult } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import {
  type HealthCheckResult,
  httpHealthCheck,
  type PreviewRolloutDependencies,
  runPreviewRollout,
} from "./rollout.js";

const input = {
  deploymentId: "33333333-3333-4333-8333-333333333333",
  environmentId: "22222222-2222-4222-8222-222222222222",
  commitSha: "a".repeat(40),
  namespace: "pf-22222222-2222-4222-8222-222222222222",
  deploymentName: "preview",
  hostname: "preview-22222222-2222-4222-8222-222222222222.preview.localhost",
  healthPath: "/healthz",
  rolloutTimeoutMs: 100,
  pollIntervalMs: 0,
  healthCheckTimeoutMs: 100,
};

const appliedTransition = {
  applied: true,
  deployment: {},
  outboxEventId: "55555555-5555-4555-8555-555555555555",
  eventType: "deployment.stage-changed.v1",
} as unknown as DeploymentTransitionResult;

function availableDeployment() {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "preview", generation: 1 },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
      readyReplicas: 1,
    },
  };
}

function dependencies(
  deployment: Awaited<ReturnType<PreviewRolloutDependencies["kubernetes"]["get"]>>,
  health: Awaited<ReturnType<NonNullable<PreviewRolloutDependencies["healthCheck"]>>>,
  desired = true,
) {
  const transitions: Array<Record<string, unknown>> = [];
  const deps: PreviewRolloutDependencies = {
    kubernetes: { get: async () => deployment },
    deployments: {
      isDesired: async () => desired,
      supersedeIfStale: async (value) => {
        transitions.push(value);
        return appliedTransition;
      },
      transition: async (value) => {
        transitions.push(value);
        return appliedTransition;
      },
    },
    healthCheck: async () => health,
    sleep: async () => undefined,
  };
  return { deps, transitions };
}

describe("runPreviewRollout", () => {
  it("publishes READY only after available rollout and successful health-check", async () => {
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: true,
      statusCode: 200,
    });
    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("READY");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      expectedStatus: "WAITING_FOR_HEALTHCHECK",
      to: "READY",
      expectedDesiredSha: input.commitSha,
    });
  });

  it("records a durable timeout failure when the Deployment never becomes available", async () => {
    let now = 0;
    const { deps, transitions } = dependencies(null, { ok: true, statusCode: 200 });
    deps.now = () => {
      now += 50;
      return now;
    };
    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      expectedStatus: "WAITING_FOR_HEALTHCHECK",
      to: "FAILED",
      failure: { stage: "ROLLOUT", code: "ROLLOUT_TIMEOUT", retryable: true },
    });
  });

  it("bounds a never-resolving Kubernetes read and records rollout timeout", async () => {
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: true,
      statusCode: 200,
    });
    deps.kubernetes.get = () => new Promise(() => undefined);
    const startedAt = Date.now();

    const result = await runPreviewRollout(
      { ...input, rolloutTimeoutMs: 25, pollIntervalMs: 5 },
      deps,
    );

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "ROLLOUT", code: "ROLLOUT_TIMEOUT", retryable: true },
    });
  });

  it("records a non-retryable rollout failure from Kubernetes", async () => {
    const { deps, transitions } = dependencies(
      {
        ...availableDeployment(),
        status: {
          conditions: [
            { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" },
          ],
        },
      },
      { ok: true, statusCode: 200 },
    );
    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "ROLLOUT", code: "ROLLOUT_FAILED", retryable: false },
    });
  });

  it("records a failed health-check without publishing READY", async () => {
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_FAILED", retryable: false },
    });
  });

  it("preserves an observed failed response at the rollout deadline", async () => {
    let now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    deps.now = () => now;
    deps.healthCheck = vi.fn(async (): Promise<HealthCheckResult> => {
      now = 101;
      return { ok: false, code: "HEALTHCHECK_FAILED" };
    });

    const result = await runPreviewRollout({ ...input, rolloutTimeoutMs: 100 }, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_FAILED", retryable: false },
    });
  });

  it("records a transient health-check outage as retryable", async () => {
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_UNAVAILABLE",
    });
    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_UNAVAILABLE", retryable: true },
    });
  });

  it("classifies a thrown custom health-check as a transient outage", async () => {
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: true,
      statusCode: 200,
    });
    deps.healthCheck = async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    };

    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_UNAVAILABLE", retryable: true },
    });
  });

  it("distinguishes a transport error from a stable HTTP 404", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    );
    await expect(httpHealthCheck("http://preview.invalid/healthz", 100)).resolves.toEqual({
      ok: false,
      code: "HEALTHCHECK_UNAVAILABLE",
    });

    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(httpHealthCheck("http://preview.invalid/healthz", 100)).resolves.toEqual({
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    fetchMock.mockRestore();
  });

  it("retries a transient failed health-check before publishing READY", async () => {
    let now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    deps.now = () => now;
    deps.sleep = async (milliseconds) => {
      now += Math.max(milliseconds, 1);
    };
    deps.healthCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "HEALTHCHECK_FAILED" })
      .mockResolvedValueOnce({ ok: true, statusCode: 200 });

    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("READY");
    expect(deps.healthCheck).toHaveBeenCalledTimes(2);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ to: "READY" });
  });

  it("records a durable failed-health outcome after the bounded retry deadline", async () => {
    let now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    deps.now = () => now;
    deps.sleep = async (milliseconds) => {
      now += Math.max(milliseconds, 1);
    };
    deps.healthCheck = vi.fn(
      async (): Promise<HealthCheckResult> => ({
        ok: false,
        code: "HEALTHCHECK_FAILED",
      }),
    );

    const result = await runPreviewRollout({ ...input, pollIntervalMs: 25 }, deps);

    expect(result.kind).toBe("FAILED");
    expect(deps.healthCheck).toHaveBeenCalledTimes(4);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_FAILED", retryable: false },
    });
  });

  it("does not spin when an injected clock and sleeper make no progress", async () => {
    const now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    deps.now = () => now;
    deps.sleep = async () => undefined;
    deps.healthCheck = vi.fn(
      async (): Promise<HealthCheckResult> => ({
        ok: false,
        code: "HEALTHCHECK_FAILED",
      }),
    );

    const result = await runPreviewRollout({ ...input, pollIntervalMs: 0 }, deps);

    expect(result.kind).toBe("FAILED");
    expect(deps.healthCheck).toHaveBeenCalledTimes(1);
    expect(transitions[0]).toMatchObject({
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_FAILED" },
    });
  });

  it("retains the timeout classification after health-check retries", async () => {
    let now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_TIMEOUT",
    });
    deps.now = () => now;
    deps.sleep = async (milliseconds) => {
      now += Math.max(milliseconds, 1);
    };
    deps.healthCheck = vi.fn(
      async (): Promise<HealthCheckResult> => ({
        ok: false,
        code: "HEALTHCHECK_TIMEOUT",
      }),
    );

    const result = await runPreviewRollout({ ...input, pollIntervalMs: 25 }, deps);

    expect(result.kind).toBe("FAILED");
    expect(transitions[0]).toMatchObject({
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_TIMEOUT", retryable: true },
    });
  });

  it("does not probe or publish READY after the rollout deadline", async () => {
    const now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: true,
      statusCode: 200,
    });
    deps.now = () => now;
    deps.healthCheck = vi.fn(
      async (): Promise<HealthCheckResult> => ({
        ok: true,
        statusCode: 200,
      }),
    );

    const result = await runPreviewRollout({ ...input, rolloutTimeoutMs: 0 }, deps);

    expect(result.kind).toBe("FAILED");
    expect(deps.healthCheck).not.toHaveBeenCalled();
    expect(transitions[0]).toMatchObject({
      to: "FAILED",
      failure: { stage: "HEALTHCHECK", code: "HEALTHCHECK_TIMEOUT", retryable: true },
    });
  });

  it("supersedes stale work during a failed-health retry", async () => {
    let now = 0;
    const { deps, transitions } = dependencies(availableDeployment(), {
      ok: false,
      code: "HEALTHCHECK_FAILED",
    });
    deps.now = () => now;
    deps.sleep = async (milliseconds) => {
      now += Math.max(milliseconds, 1);
    };
    deps.deployments.isDesired = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    deps.healthCheck = vi.fn(
      async (): Promise<HealthCheckResult> => ({
        ok: false,
        code: "HEALTHCHECK_FAILED",
      }),
    );

    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("SUPERSEDED");
    expect(deps.healthCheck).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      expectedStatus: "WAITING_FOR_HEALTHCHECK",
      expectedCommitSha: input.commitSha,
    });
  });

  it("supersedes when the desired SHA changes after health-check", async () => {
    const transitions: Array<Record<string, unknown>> = [];
    const deps = dependencies(availableDeployment(), { ok: true, statusCode: 200 }).deps;
    let checks = 0;
    deps.deployments.isDesired = async () => {
      checks += 1;
      return checks === 1;
    };
    deps.deployments.supersedeIfStale = vi.fn(async (value) => {
      transitions.push(value);
      return appliedTransition;
    });
    const result = await runPreviewRollout(input, deps);

    expect(result.kind).toBe("SUPERSEDED");
    expect(transitions[0]).toMatchObject({
      expectedStatus: "WAITING_FOR_HEALTHCHECK",
      expectedCommitSha: input.commitSha,
    });
  });
});
