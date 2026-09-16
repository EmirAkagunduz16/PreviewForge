import type { DeploymentTransitionResult } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import type { BuildKitBuildInput, BuildKitBuildResult } from "./buildkit-adapter.js";
import { runDeploymentBuildPipeline } from "./deployment-build-pipeline.js";

const input = {
  deploymentId: "deployment-1",
  desiredSha: "a".repeat(40),
  source: {
    installationId: "123",
    repositoryFullName: "previewforge/demo",
    commitSha: "a".repeat(40),
    dockerfilePath: "Dockerfile",
  },
  imageReference: "registry.local/previewforge/demo:deployment-1",
};

function dependencies(
  overrides: {
    transition?: (value: Record<string, unknown>) => Promise<DeploymentTransitionResult>;
    build?: (input: BuildKitBuildInput) => Promise<BuildKitBuildResult>;
    supersedeIfStale?: () => Promise<DeploymentTransitionResult>;
  } = {},
) {
  const cleanup = vi.fn(async () => undefined);
  const transitions: Record<string, unknown>[] = [];
  return {
    transitions,
    sourceClient: {
      fetchArchive: vi.fn(async () => ({ ...input.source, bytes: new Uint8Array() })),
    },
    materialize: vi.fn(async () => ({
      contextPath: "/tmp/context",
      dockerfilePath: "Dockerfile",
      cleanup,
    })),
    buildkit: {
      buildAndPush: vi.fn(
        overrides.build ??
          (async () => ({
            imageReference: input.imageReference,
            digest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
          })),
      ),
    },
    deployments: {
      transition: vi.fn(async (value: Record<string, unknown>) => {
        transitions.push(value);
        return overrides.transition?.(value) ?? success();
      }),
      supersedeIfStale: vi.fn(overrides.supersedeIfStale ?? (async () => success())),
    },
    logChunks: { append: vi.fn(async () => null) },
  };
}

function success(): DeploymentTransitionResult {
  return {
    applied: true,
    deployment: {} as never,
    outboxEventId: "e",
    eventType: "deployment.stage-changed.v1",
  };
}

describe("runDeploymentBuildPipeline", () => {
  it("runs guarded stages, persists the returned digest, and cleans the context", async () => {
    const deps = dependencies();
    const output: BuildKitBuildInput[] = [];
    deps.buildkit.buildAndPush.mockImplementation(async (buildInput) => {
      output.push(buildInput);
      await buildInput.onOutput?.({ stream: "stdout", text: "durable build output\n" });
      return {
        imageReference: input.imageReference,
        digest: `sha256:${"b".repeat(64)}`,
      };
    });
    const result = await runDeploymentBuildPipeline(input, deps);

    expect(result).toEqual({ kind: "DEPLOYING", digest: `sha256:${"b".repeat(64)}` });
    expect(deps.transitions.map((transition) => transition.to)).toEqual([
      "BUILDING",
      "PUSHING",
      "DEPLOYING",
    ]);
    expect(deps.transitions[2]).toMatchObject({ imageDigest: `sha256:${"b".repeat(64)}` });
    expect(deps.logChunks.append).toHaveBeenCalledWith({
      deploymentId: input.deploymentId,
      desiredSha: input.desiredSha,
      stage: "PUSHING",
      stream: "stdout",
      text: "durable build output\n",
    });
    expect(output).toHaveLength(1);
    expect(deps.materialize).toHaveBeenCalledOnce();
  });

  it("fails durably and cleans up when BuildKit is unavailable", async () => {
    const deps = dependencies({
      build: async () => {
        throw Object.assign(new Error("unavailable"), {
          code: "BUILDKIT_UNAVAILABLE",
          retryable: true,
        });
      },
    });
    const result = await runDeploymentBuildPipeline(input, deps);

    expect(result).toEqual({ kind: "FAILED", stage: "PUSHING", code: "BUILDKIT_UNAVAILABLE" });
    expect(deps.transitions.at(-1)).toMatchObject({ to: "FAILED", expectedStatus: "PUSHING" });
  });

  it("cannot report build success after a durable log append failure", async () => {
    const deps = dependencies();
    deps.logChunks.append.mockRejectedValue(new Error("database password leaked"));
    deps.buildkit.buildAndPush.mockImplementation(async (buildInput) => {
      await buildInput.onOutput?.({ stream: "stderr", text: "output" });
      return {
        imageReference: input.imageReference,
        digest: `sha256:${"b".repeat(64)}`,
      };
    });
    const result = await runDeploymentBuildPipeline(input, deps);
    expect(result).toEqual({ kind: "FAILED", stage: "PUSHING", code: "BUILDKIT_FAILED" });
    expect(deps.transitions.at(-1)).toMatchObject({
      to: "FAILED",
      failure: { code: "BUILDKIT_FAILED", message: "Deployment build pipeline failed" },
    });
    expect(JSON.stringify(deps.transitions)).not.toContain("database password leaked");
  });

  it("does not publish a digest when the desired SHA becomes stale", async () => {
    const supersedeIfStale = vi.fn(async () => ({
      applied: true as const,
      deployment: {} as never,
      outboxEventId: "superseded-event",
      eventType: "deployment.stage-changed.v1",
    }));
    const depsWithSupersede = dependencies({
      transition: async (value) =>
        value.to === "DEPLOYING"
          ? { applied: false, reason: "DESIRED_SHA_MISMATCH", currentStatus: "PUSHING" }
          : success(),
      supersedeIfStale,
    });
    const result = await runDeploymentBuildPipeline(input, depsWithSupersede);

    expect(result).toEqual({ kind: "SUPERSEDED" });
    expect(depsWithSupersede.transitions.at(-1)).toMatchObject({ to: "DEPLOYING" });
    expect(supersedeIfStale).toHaveBeenCalledWith({
      deploymentId: input.deploymentId,
      expectedStatus: "PUSHING",
      expectedCommitSha: input.desiredSha,
    });
  });
});
