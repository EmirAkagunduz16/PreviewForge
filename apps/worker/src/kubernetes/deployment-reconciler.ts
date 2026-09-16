import type { DeploymentRequested } from "@previewforge/contracts";
import type { DeploymentTransitionResult } from "@previewforge/database";
import {
  KubernetesReconciler,
  type KubernetesResourceClient,
  PreviewSupersededError,
} from "./reconciler.js";
import { type PreviewRolloutDependencies, runPreviewRollout } from "./rollout.js";

export type PreviewDeploymentReconcileDependencies = {
  kubernetes: KubernetesReconciler;
  deployments: PreviewRolloutDependencies["deployments"];
  rollout?: Omit<PreviewRolloutDependencies, "kubernetes" | "deployments"> & {
    kubernetes: Pick<KubernetesResourceClient, "get">;
    deployments?: never;
  };
};

export type PreviewDeploymentReconcileInput = {
  event: DeploymentRequested;
  imageReference: string;
  imageDigest: string;
  containerPort: number;
  healthPath: string;
  healthCheckUrl?: string;
  rolloutTimeoutMs?: number;
  pollIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  expiresAt?: Date | null;
  environment?: Record<string, string>;
};

export type PreviewDeploymentReconcileResult =
  | { kind: "WAITING_FOR_HEALTHCHECK"; transition: DeploymentTransitionResult }
  | { kind: "READY"; transition: DeploymentTransitionResult }
  | { kind: "FAILED"; transition: DeploymentTransitionResult }
  | { kind: "SUPERSEDED"; transition?: DeploymentTransitionResult };

export function createKubernetesReconciler(client: KubernetesResourceClient): KubernetesReconciler {
  return new KubernetesReconciler(client);
}

export async function reconcilePreviewDeployment(
  input: PreviewDeploymentReconcileInput,
  dependencies: PreviewDeploymentReconcileDependencies,
): Promise<PreviewDeploymentReconcileResult> {
  const isDesired = () =>
    dependencies.deployments.isDesired(input.event.deploymentId, input.event.commitSha);
  let rendered: Awaited<ReturnType<KubernetesReconciler["reconcile"]>>;

  try {
    rendered = await dependencies.kubernetes.reconcile({
      projectId: input.event.projectId,
      environmentId: input.event.environmentId,
      deploymentId: input.event.deploymentId,
      desiredCommitSha: input.event.commitSha,
      imageReference: input.imageReference,
      imageDigest: input.imageDigest,
      containerPort: input.containerPort,
      healthPath: input.healthPath,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      isDesired,
    });
  } catch (error) {
    if (!(error instanceof PreviewSupersededError)) throw error;
    const transition = await dependencies.deployments.supersedeIfStale({
      deploymentId: input.event.deploymentId,
      expectedStatus: "DEPLOYING",
      expectedCommitSha: input.event.commitSha,
    });
    return { kind: "SUPERSEDED", transition };
  }

  const transition = await dependencies.deployments.transition({
    deploymentId: input.event.deploymentId,
    expectedStatus: "DEPLOYING",
    to: "WAITING_FOR_HEALTHCHECK",
    expectedDesiredSha: input.event.commitSha,
  });
  if (!transition.applied) {
    if (transition.reason === "DESIRED_SHA_MISMATCH") {
      const superseded = await dependencies.deployments.supersedeIfStale({
        deploymentId: input.event.deploymentId,
        expectedStatus: "DEPLOYING",
        expectedCommitSha: input.event.commitSha,
      });
      return { kind: "SUPERSEDED", transition: superseded };
    }
    throw new Error(`deployment reconciliation transition failed: ${transition.reason}`);
  }
  if (dependencies.rollout === undefined) return { kind: "WAITING_FOR_HEALTHCHECK", transition };
  return runPreviewRollout(
    {
      deploymentId: input.event.deploymentId,
      environmentId: input.event.environmentId,
      commitSha: input.event.commitSha,
      namespace: rendered.namespace,
      deploymentName: "preview",
      hostname: rendered.hostname,
      healthPath: input.healthPath,
      ...(input.healthCheckUrl === undefined ? {} : { healthCheckUrl: input.healthCheckUrl }),
      ...(input.rolloutTimeoutMs === undefined ? {} : { rolloutTimeoutMs: input.rolloutTimeoutMs }),
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.healthCheckTimeoutMs === undefined
        ? {}
        : { healthCheckTimeoutMs: input.healthCheckTimeoutMs }),
    },
    { ...dependencies.rollout, deployments: dependencies.deployments },
  );
}
