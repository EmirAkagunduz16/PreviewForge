import type { DeploymentRequested } from "@previewforge/contracts";
import type { DeploymentTransitionResult } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import { reconcilePreviewDeployment } from "./deployment-reconciler.js";
import { KubernetesReconciler } from "./reconciler.js";

const event: DeploymentRequested = {
  eventId: "44444444-4444-4444-8444-444444444444",
  eventType: "deployment.requested.v1",
  occurredAt: "2026-09-14T18:00:00.000Z",
  deploymentId: "33333333-3333-4333-8333-333333333333",
  environmentId: "22222222-2222-4222-8222-222222222222",
  projectId: "11111111-1111-4111-8111-111111111111",
  installationId: "123456",
  repositoryFullName: "previewforge/example",
  pullRequestNumber: 1,
  commitSha: "a".repeat(40),
};

const appliedTransition = {
  applied: true,
  deployment: {},
  outboxEventId: "55555555-5555-4555-8555-555555555555",
  eventType: "deployment.stage-changed.v1",
} as unknown as DeploymentTransitionResult;

function makeDependencies(desired: () => Promise<boolean>) {
  const deployments = {
    isDesired: vi.fn(desired),
    supersedeIfStale: vi.fn(async () => appliedTransition),
    transition: vi.fn(async () => appliedTransition),
  };
  const kubernetes = new KubernetesReconciler({
    get: async () => null,
    apply: async () => undefined,
  });
  return { dependencies: { kubernetes, deployments }, deployments };
}

describe("reconcilePreviewDeployment", () => {
  it("advances a successfully applied preview to health-check waiting", async () => {
    const { dependencies, deployments } = makeDependencies(async () => true);
    const result = await reconcilePreviewDeployment(
      {
        event,
        imageReference: "registry.local/project/deployment:commit",
        imageDigest: `sha256:${"b".repeat(64)}`,
        containerPort: 3000,
        healthPath: "/healthz",
      },
      dependencies,
    );

    expect(result.kind).toBe("WAITING_FOR_HEALTHCHECK");
    expect(deployments.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: "DEPLOYING",
        to: "WAITING_FOR_HEALTHCHECK",
        expectedDesiredSha: event.commitSha,
      }),
    );
    const transitionInput = deployments.transition.mock.calls[0] as
      | [Record<string, unknown>]
      | undefined;
    expect(transitionInput?.[0]).not.toHaveProperty("imageDigest");
  });

  it("preserves the digest persisted when entering DEPLOYING", async () => {
    const originalDigest = `sha256:${"c".repeat(64)}`;
    let persistedDigest = originalDigest;
    const deployments = {
      isDesired: vi.fn(async () => true),
      supersedeIfStale: vi.fn(async () => appliedTransition),
      transition: vi.fn(async (request: { imageDigest?: string }) => {
        if (Object.hasOwn(request, "imageDigest")) {
          persistedDigest = "overwritten";
          throw new Error("immutable digest cannot be supplied on this transition");
        }
        return appliedTransition;
      }),
    };
    const dependencies = {
      kubernetes: new KubernetesReconciler({
        get: async () => null,
        apply: async () => undefined,
      }),
      deployments,
    };

    const result = await reconcilePreviewDeployment(
      {
        event,
        imageReference: "registry.local/project/deployment:commit",
        imageDigest: originalDigest,
        containerPort: 3000,
        healthPath: "/healthz",
      },
      dependencies,
    );

    expect(result.kind).toBe("WAITING_FOR_HEALTHCHECK");
    expect(persistedDigest).toBe(originalDigest);
    expect(deployments.transition.mock.calls[0]?.[0]).toEqual(
      expect.not.objectContaining({ imageDigest: expect.anything() }),
    );
  });

  it("supersedes without applying resources when desired SHA is no longer current", async () => {
    const { dependencies, deployments } = makeDependencies(async () => false);
    const result = await reconcilePreviewDeployment(
      {
        event,
        imageReference: "registry.local/project/deployment:commit",
        imageDigest: `sha256:${"b".repeat(64)}`,
        containerPort: 3000,
        healthPath: "/healthz",
      },
      dependencies,
    );

    expect(result.kind).toBe("SUPERSEDED");
    expect(deployments.supersedeIfStale).toHaveBeenCalledWith({
      deploymentId: event.deploymentId,
      expectedStatus: "DEPLOYING",
      expectedCommitSha: event.commitSha,
    });
  });
});
