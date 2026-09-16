import type { DeploymentTransitionResult } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import {
  classifyKubernetesFailure,
  type KubernetesFailurePersistence,
  persistKubernetesFailure,
} from "./failure-persistence.js";

const deploymentId = "33333333-3333-4333-8333-333333333333";
const commitSha = "a".repeat(40);

const applied = {
  applied: true,
  deployment: {},
  outboxEventId: "55555555-5555-4555-8555-555555555555",
  eventType: "deployment.failed.v1",
} as unknown as DeploymentTransitionResult;

function notApplied(
  reason: Extract<DeploymentTransitionResult, { applied: false }>["reason"],
  currentStatus?: "DEPLOYING" | "WAITING_FOR_HEALTHCHECK",
): DeploymentTransitionResult {
  return {
    applied: false,
    reason,
    ...(currentStatus === undefined ? {} : { currentStatus }),
  };
}

function persistence(
  transition: KubernetesFailurePersistence["transition"],
  supersedeIfStale: KubernetesFailurePersistence["supersedeIfStale"] = vi
    .fn()
    .mockResolvedValue(notApplied("EXPECTED_STATUS_MISMATCH", "DEPLOYING")),
): KubernetesFailurePersistence {
  return { transition, supersedeIfStale };
}

describe("classifyKubernetesFailure", () => {
  it.each([
    [
      new Error("Invalid worker configuration: PREVIEWFORGE_ROLLOUT_TIMEOUT_MS is invalid"),
      { stage: "CONFIGURATION", code: "WORKER_DURATION_INVALID", retryable: false },
    ],
    [
      new Error("PREVIEWFORGE_HEALTHCHECK_URL_TEMPLATE is invalid"),
      { stage: "CONFIGURATION", code: "HEALTHCHECK_URL_INVALID", retryable: false },
    ],
    [
      Object.assign(new Error("forbidden by admission policy"), { statusCode: 403 }),
      { stage: "KUBERNETES", code: "KUBERNETES_POLICY_REJECTED", retryable: false },
    ],
    [
      Object.assign(new Error("unprocessable resource"), { statusCode: 422 }),
      { stage: "KUBERNETES", code: "KUBERNETES_API_REJECTED", retryable: false },
    ],
    [
      Object.assign(new Error("rate limited"), { statusCode: 429 }),
      { stage: "KUBERNETES", code: "KUBERNETES_RATE_LIMITED", retryable: true },
    ],
    [
      Object.assign(new Error("api unavailable"), { response: { statusCode: 503 } }),
      { stage: "KUBERNETES", code: "KUBERNETES_API_UNAVAILABLE", retryable: true },
    ],
    [
      Object.assign(new Error("mutation timed out"), { code: "KUBERNETES_API_TIMEOUT" }),
      { stage: "KUBERNETES", code: "KUBERNETES_API_TIMEOUT", retryable: true },
    ],
    [
      Object.assign(new Error("health endpoint unavailable"), { code: "HEALTHCHECK_UNAVAILABLE" }),
      { stage: "HEALTHCHECK", code: "HEALTHCHECK_UNAVAILABLE", retryable: true },
    ],
    [
      Object.assign(new Error("health endpoint returned 404"), { code: "HEALTHCHECK_FAILED" }),
      { stage: "HEALTHCHECK", code: "HEALTHCHECK_FAILED", retryable: false },
    ],
    [
      Object.assign(new Error("Project environment configuration could not be authenticated"), {
        code: "ENVIRONMENT_VARIABLE_DECRYPTION_FAILED",
      }),
      { stage: "CONFIGURATION", code: "ENVIRONMENT_VARIABLE_DECRYPTION_FAILED", retryable: false },
    ],
    [
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      { stage: "KUBERNETES", code: "KUBERNETES_NETWORK_ERROR", retryable: true },
    ],
  ])("maps safe failure metadata", (error, expected) => {
    expect(classifyKubernetesFailure(error)).toMatchObject(expected);
  });

  it("never returns an upstream error message that could contain a secret", () => {
    const classified = classifyKubernetesFailure(
      new Error("authorization: Bearer very-secret-token from Kubernetes"),
    );

    expect(classified.message).not.toContain("very-secret-token");
    expect(classified).toMatchObject({
      stage: "KUBERNETES",
      code: "KUBERNETES_RECONCILIATION_FAILED",
      retryable: true,
    });
  });
});

describe("persistKubernetesFailure", () => {
  it("persists an injected post-WAITING failure instead of falsely completing the message", async () => {
    const transition = vi
      .fn<KubernetesFailurePersistence["transition"]>()
      .mockResolvedValueOnce(notApplied("EXPECTED_STATUS_MISMATCH", "WAITING_FOR_HEALTHCHECK"))
      .mockResolvedValueOnce(applied);
    const deployments = persistence(transition);

    await expect(
      persistKubernetesFailure({
        deployments,
        deploymentId,
        commitSha,
        error: new Error("injected post-WAITING failure"),
      }),
    ).resolves.toBe("FAILED");

    expect(transition).toHaveBeenNthCalledWith(1, {
      deploymentId,
      expectedStatus: "DEPLOYING",
      to: "FAILED",
      expectedDesiredSha: commitSha,
      failure: {
        stage: "KUBERNETES",
        code: "KUBERNETES_RECONCILIATION_FAILED",
        message: "Kubernetes preview reconciliation failed",
        retryable: true,
      },
    });
    expect(transition).toHaveBeenNthCalledWith(2, {
      deploymentId,
      expectedStatus: "WAITING_FOR_HEALTHCHECK",
      to: "FAILED",
      expectedDesiredSha: commitSha,
      failure: expect.anything(),
    });
  });

  it("supersedes stale work rather than recording a failure", async () => {
    const transition = vi
      .fn<KubernetesFailurePersistence["transition"]>()
      .mockResolvedValue(notApplied("DESIRED_SHA_MISMATCH", "DEPLOYING"));
    const supersedeIfStale = vi
      .fn<KubernetesFailurePersistence["supersedeIfStale"]>()
      .mockResolvedValue(applied);

    await expect(
      persistKubernetesFailure({
        deployments: persistence(transition, supersedeIfStale),
        deploymentId,
        commitSha,
        error: new Error("stale worker"),
      }),
    ).resolves.toBe("SUPERSEDED");
    expect(supersedeIfStale).toHaveBeenCalledWith({
      deploymentId,
      expectedStatus: "DEPLOYING",
      expectedCommitSha: commitSha,
    });
  });

  it("rethrows when no terminal or superseded transition was applied", async () => {
    const original = new Error("post-WAITING fault");
    const transition = vi
      .fn<KubernetesFailurePersistence["transition"]>()
      .mockResolvedValueOnce(notApplied("EXPECTED_STATUS_MISMATCH", "WAITING_FOR_HEALTHCHECK"))
      .mockResolvedValueOnce(notApplied("TERMINAL", "WAITING_FOR_HEALTHCHECK"));

    await expect(
      persistKubernetesFailure({
        deployments: persistence(transition),
        deploymentId,
        commitSha,
        error: original,
      }),
    ).rejects.toBe(original);
  });
});
