import type {
  DeploymentRepository,
  DeploymentTransitionResult,
  LogChunkRepository,
} from "@previewforge/database";
import type { GitHubSourceClient, GitHubSourceRequest } from "../source/github-source.js";
import type { BuildKitAdapter, BuildKitBuildResult } from "./buildkit-adapter.js";
import type { DisposableBuildContext } from "./source-context.js";
import { materializeSourceContext } from "./source-context.js";

export type DeploymentBuildPipelineInput = {
  deploymentId: string;
  desiredSha: string;
  source: GitHubSourceRequest;
  imageReference: string;
};

export type DeploymentBuildPipelineDependencies = {
  sourceClient: Pick<GitHubSourceClient, "fetchArchive">;
  buildkit: Pick<BuildKitAdapter, "buildAndPush">;
  deployments: Pick<DeploymentRepository, "transition" | "supersedeIfStale">;
  logChunks?: Pick<LogChunkRepository, "append">;
  materialize?: typeof materializeSourceContext;
};

export type DeploymentBuildPipelineResult =
  | { kind: "DEPLOYING"; digest: string }
  | { kind: "SUPERSEDED" }
  | { kind: "FAILED"; stage: "SOURCE" | "BUILDING" | "PUSHING"; code: string };

/**
 * Runs the source/build/push half of a deployment after M3 has claimed it in
 * CLONING. Every durable state change is a desired-SHA compare-and-set.
 */
export async function runDeploymentBuildPipeline(
  input: DeploymentBuildPipelineInput,
  dependencies: DeploymentBuildPipelineDependencies,
): Promise<DeploymentBuildPipelineResult> {
  let context: DisposableBuildContext | undefined;
  try {
    const archive = await dependencies.sourceClient.fetchArchive(input.source);
    context = await (dependencies.materialize ?? materializeSourceContext)(archive);

    const building = await dependencies.deployments.transition({
      deploymentId: input.deploymentId,
      expectedStatus: "CLONING",
      to: "BUILDING",
      expectedDesiredSha: input.desiredSha,
    });
    if (!building.applied) return transitionNoop(building, "SOURCE");

    const pushing = await dependencies.deployments.transition({
      deploymentId: input.deploymentId,
      expectedStatus: "BUILDING",
      to: "PUSHING",
      expectedDesiredSha: input.desiredSha,
    });
    if (!pushing.applied) return transitionNoop(pushing, "BUILDING");

    let build: BuildKitBuildResult;
    try {
      build = await dependencies.buildkit.buildAndPush({
        contextPath: context.contextPath,
        dockerfilePath: context.dockerfilePath,
        imageReference: input.imageReference,
        onOutput: async ({ stream, text }) => {
          if (!dependencies.logChunks) return;
          await dependencies.logChunks.append({
            deploymentId: input.deploymentId,
            desiredSha: input.desiredSha,
            stage: "PUSHING",
            stream,
            text,
          });
        },
      });
    } catch (error) {
      return await fail(dependencies, input, "PUSHING", classifyBuildFailure(error));
    }

    const deployed = await dependencies.deployments.transition({
      deploymentId: input.deploymentId,
      expectedStatus: "PUSHING",
      to: "DEPLOYING",
      expectedDesiredSha: input.desiredSha,
      imageDigest: build.digest,
    });
    if (!deployed.applied && deployed.reason === "DESIRED_SHA_MISMATCH") {
      const superseded = await dependencies.deployments.supersedeIfStale({
        deploymentId: input.deploymentId,
        expectedStatus: "PUSHING",
        expectedCommitSha: input.desiredSha,
      });
      if (superseded.applied) return { kind: "SUPERSEDED" };
    }
    if (!deployed.applied) return transitionNoop(deployed, "PUSHING");
    return { kind: "DEPLOYING", digest: build.digest };
  } catch (error) {
    return await fail(dependencies, input, "SOURCE", classifySourceFailure(error));
  } finally {
    await context?.cleanup().catch(() => undefined);
  }
}

async function fail(
  dependencies: DeploymentBuildPipelineDependencies,
  input: DeploymentBuildPipelineInput,
  stage: "SOURCE" | "BUILDING" | "PUSHING",
  failure: { code: string; retryable: boolean },
): Promise<DeploymentBuildPipelineResult> {
  const expectedStatus = stage === "SOURCE" ? "CLONING" : "PUSHING";
  const result = await dependencies.deployments.transition({
    deploymentId: input.deploymentId,
    expectedStatus,
    to: "FAILED",
    expectedDesiredSha: input.desiredSha,
    failure: {
      stage,
      code: failure.code,
      message: "Deployment build pipeline failed",
      retryable: failure.retryable,
    },
  });
  if (!result.applied && result.reason === "DESIRED_SHA_MISMATCH") return { kind: "SUPERSEDED" };
  return { kind: "FAILED", stage, code: failure.code };
}

function transitionNoop(
  result: Exclude<DeploymentTransitionResult, { applied: true }>,
  stage: "SOURCE" | "BUILDING" | "PUSHING",
): DeploymentBuildPipelineResult {
  return result.reason === "DESIRED_SHA_MISMATCH"
    ? { kind: "SUPERSEDED" }
    : { kind: "FAILED", stage, code: `TRANSITION_${result.reason}` };
}

function classifySourceFailure(error: unknown): { code: string; retryable: boolean } {
  if (isRecord(error) && typeof error.code === "string") {
    return { code: error.code, retryable: error.retryable === true };
  }
  return { code: "SOURCE_CONTEXT_FAILED", retryable: false };
}

function classifyBuildFailure(error: unknown): { code: string; retryable: boolean } {
  if (isRecord(error) && typeof error.code === "string") {
    return { code: error.code, retryable: error.retryable === true };
  }
  return { code: "BUILDKIT_FAILED", retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
