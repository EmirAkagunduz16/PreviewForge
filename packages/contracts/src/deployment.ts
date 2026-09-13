import { z } from "zod";
import { githubInstallationIdSchema } from "./github.js";

export const deploymentStatuses = [
  "QUEUED",
  "CLONING",
  "BUILDING",
  "PUSHING",
  "DEPLOYING",
  "WAITING_FOR_HEALTHCHECK",
  "READY",
  "FAILED",
  "SUPERSEDED",
  "CANCELLED",
] as const;

export const deploymentStatusSchema = z.enum(deploymentStatuses);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

const transitions = {
  QUEUED: ["CLONING", "CANCELLED", "FAILED", "SUPERSEDED"],
  CLONING: ["BUILDING", "CANCELLED", "FAILED", "SUPERSEDED"],
  BUILDING: ["PUSHING", "CANCELLED", "FAILED", "SUPERSEDED"],
  PUSHING: ["DEPLOYING", "CANCELLED", "FAILED", "SUPERSEDED"],
  DEPLOYING: ["WAITING_FOR_HEALTHCHECK", "CANCELLED", "FAILED", "SUPERSEDED"],
  WAITING_FOR_HEALTHCHECK: ["READY", "CANCELLED", "FAILED", "SUPERSEDED"],
  READY: ["SUPERSEDED"],
  FAILED: [],
  SUPERSEDED: [],
  CANCELLED: [],
} as const satisfies Record<DeploymentStatus, readonly DeploymentStatus[]>;

export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return (transitions[from] as readonly DeploymentStatus[]).includes(to);
}

export const deploymentRequestedSchema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("deployment.requested.v1"),
  occurredAt: z.iso.datetime(),
  deploymentId: z.uuid(),
  environmentId: z.uuid(),
  projectId: z.uuid(),
  installationId: githubInstallationIdSchema,
  repositoryFullName: z.string().regex(/^[^/]+\/[^/]+$/),
  pullRequestNumber: z.int().positive(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
});

export type DeploymentRequested = z.infer<typeof deploymentRequestedSchema>;
