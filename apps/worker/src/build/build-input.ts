import type { DeploymentRequested } from "@previewforge/contracts";
import type { ProjectImportRecord } from "@previewforge/database";

export type BuildInputConfig = {
  registryHost: string;
};

export type ResolvedBuildInput = {
  source: {
    installationId: string;
    repositoryFullName: string;
    commitSha: string;
    dockerfilePath: string;
  };
  imageReference: string;
};

/** Converts persisted project configuration and a validated event into the narrow build input. */
export function resolveBuildInput(
  event: DeploymentRequested,
  project: Pick<ProjectImportRecord, "installationId" | "repositoryFullName" | "dockerfilePath">,
  config: BuildInputConfig,
): ResolvedBuildInput {
  if (project.installationId !== event.installationId) {
    throw new Error("Build project installation does not match deployment event");
  }
  if (project.repositoryFullName !== event.repositoryFullName) {
    throw new Error("Build project repository does not match deployment event");
  }
  if (!/^[A-Za-z0-9_.-]+(?::[0-9]+)?(?:[A-Za-z0-9_.-]+)?$/u.test(config.registryHost)) {
    throw new Error("Invalid build registry host");
  }
  const dockerfilePath = project.dockerfilePath;
  if (
    dockerfilePath.length === 0 ||
    dockerfilePath.length > 256 ||
    dockerfilePath.startsWith("/") ||
    dockerfilePath.includes("\\") ||
    dockerfilePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Invalid project Dockerfile path");
  }
  const imageReference = `${config.registryHost}/${event.projectId}/${event.deploymentId}:${event.commitSha}`;
  return {
    source: {
      installationId: event.installationId,
      repositoryFullName: event.repositoryFullName,
      commitSha: event.commitSha,
      dockerfilePath,
    },
    imageReference,
  };
}
