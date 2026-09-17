import type { KafkaEvent } from "@previewforge/contracts";
import type {
  DeploymentFeedbackContext,
  DeploymentFeedbackLock,
  DeploymentFeedbackRepository,
} from "@previewforge/database";
import { type PreviewUrlConfig, previewUrl } from "../preview-url.js";
import {
  type CheckRunConclusion,
  type CheckRunStatus,
  type GitHubCheckRunClient,
  GitHubCheckRunError,
  type GitHubCheckRunRequest,
} from "./client.js";

export const GITHUB_CHECK_RUN_NAME = "PreviewForge";
export const GITHUB_CHECK_CONSUMER_NAME_SUFFIX = "github-checks";

export type DeploymentFeedbackEvent = Extract<
  KafkaEvent,
  {
    eventType:
      | "deployment.requested.v1"
      | "deployment.stage-changed.v1"
      | "deployment.ready.v1"
      | "deployment.failed.v1";
  }
>;

export type DeploymentFeedbackRepositoryPort = Pick<
  DeploymentFeedbackRepository,
  "withDeploymentLock"
>;

export type GitHubCheckRunCoordinatorOptions = {
  repository: DeploymentFeedbackRepositoryPort;
  client: Pick<GitHubCheckRunClient, "create" | "update" | "list">;
  previewUrlConfig: PreviewUrlConfig;
  consumerName: string;
};

export type DeploymentFeedbackResult = "PROCESSED" | "DUPLICATE" | "SKIPPED";

type CheckObservation = {
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
};

export class GitHubCheckRunCoordinator {
  constructor(private readonly options: GitHubCheckRunCoordinatorOptions) {}

  process(event: DeploymentFeedbackEvent): Promise<DeploymentFeedbackResult> {
    return this.options.repository.withDeploymentLock(event.deploymentId, async (lock) => {
      if (await lock.isEventProcessed(event.eventId, this.options.consumerName)) return "DUPLICATE";
      if (lock.context === null) {
        await lock.markEventProcessed(event.eventId, this.options.consumerName);
        return "SKIPPED";
      }

      const observation = createObservation(lock.context, this.options.previewUrlConfig);
      const request = toCheckRequest(lock.context, observation, event.deploymentId);
      const checkRunId = await this.ensureRemoteIdentity(lock, request);
      try {
        await this.options.client.update({ ...request, checkRunId });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const recovered = await this.recoverRemoteIdentity(lock, request);
        await this.options.client.update({ ...request, checkRunId: recovered });
      }
      await lock.markEventProcessed(event.eventId, this.options.consumerName);
      return "PROCESSED";
    });
  }

  private async ensureRemoteIdentity(
    lock: DeploymentFeedbackLock,
    request: GitHubCheckRunRequest,
  ): Promise<string> {
    if (lock.context?.checkRunId !== null && lock.context?.checkRunId !== undefined) {
      return lock.context.checkRunId;
    }

    return this.recoverRemoteIdentity(lock, request);
  }

  private async recoverRemoteIdentity(
    lock: DeploymentFeedbackLock,
    request: GitHubCheckRunRequest,
  ): Promise<string> {
    const existing = await this.findRemoteIdentity(request);
    if (existing !== undefined) {
      await storeRemoteIdentity(lock, existing);
      return existing;
    }

    let created: Awaited<ReturnType<GitHubCheckRunClient["create"]>>;
    try {
      created = await this.options.client.create(request);
    } catch (error) {
      // A transport error can happen after GitHub accepted the create. Recover
      // by external_id before allowing the event to retry.
      if (!isRetryable(error)) throw error;
      const recovered = await this.findRemoteIdentity(request);
      if (recovered === undefined) throw error;
      await storeRemoteIdentity(lock, recovered);
      return recovered;
    }
    await storeRemoteIdentity(lock, created.id);
    return created.id;
  }

  private async findRemoteIdentity(request: GitHubCheckRunRequest): Promise<string | undefined> {
    const runs = await this.options.client.list({
      installationId: request.installationId,
      repositoryFullName: request.repositoryFullName,
      headSha: request.headSha,
      name: request.name,
    });
    const matches = runs
      .filter((run) => run.externalId === request.externalId)
      .sort((left, right) => compareNumericIds(left.id, right.id));
    return matches[0]?.id;
  }
}

function createObservation(
  context: DeploymentFeedbackContext,
  urlConfig: PreviewUrlConfig,
): CheckObservation {
  const stale = context.commitSha !== context.desiredCommitSha;
  const status = stale ? "SUPERSEDED" : context.status;
  switch (status) {
    case "QUEUED":
      return {
        status: "queued",
        title: "Preview deployment queued",
        summary: `Deployment ${context.commitSha} for PR #${context.pullRequestNumber ?? "unknown"} is queued.`,
      };
    case "CLONING":
    case "BUILDING":
    case "PUSHING":
    case "DEPLOYING":
    case "WAITING_FOR_HEALTHCHECK":
      return {
        status: "in_progress",
        title: `Preview deployment ${status.toLowerCase()}`,
        summary: `Deployment ${context.commitSha} is currently in the ${status.toLowerCase()} stage.`,
      };
    case "READY": {
      const digest = context.imageDigest ?? "immutable image digest unavailable";
      const url = previewUrl(context.environmentId, urlConfig);
      return {
        status: "completed",
        conclusion: "success",
        title: "Preview deployment ready",
        summary: `Preview: [Open preview](${url})\n\nImmutable image digest: \`${digest}\``,
        detailsUrl: url,
      };
    }
    case "FAILED":
      return {
        status: "completed",
        conclusion: "failure",
        title: "Preview deployment failed",
        summary: [
          `Stage: ${safeText(context.failureStage ?? "unknown")}`,
          `Code: ${safeText(context.failureCode ?? "UNKNOWN_FAILURE")}`,
          `Message: ${safeText(context.failureMessage ?? "Deployment failed")}`,
          `Retryable: ${context.failureRetryable === true ? "yes" : "no"}`,
        ].join("\n\n"),
      };
    case "SUPERSEDED":
      return {
        status: "completed",
        conclusion: "neutral",
        title: "Preview deployment superseded",
        summary: "A newer desired commit superseded this deployment attempt.",
      };
    case "CANCELLED":
      return {
        status: "completed",
        conclusion: "cancelled",
        title: "Preview deployment cancelled",
        summary: "This preview deployment was cancelled.",
      };
    default:
      throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, 200);
  }
}

function toCheckRequest(
  context: DeploymentFeedbackContext,
  observation: CheckObservation,
  deploymentId: string,
): GitHubCheckRunRequest {
  return {
    installationId: context.installationId,
    repositoryFullName: context.repositoryFullName,
    headSha: context.commitSha,
    name: GITHUB_CHECK_RUN_NAME,
    externalId: `previewforge:deployment:${deploymentId}`,
    status: observation.status,
    ...(observation.conclusion === undefined ? {} : { conclusion: observation.conclusion }),
    title: observation.title,
    summary: observation.summary,
    ...(observation.detailsUrl === undefined ? {} : { detailsUrl: observation.detailsUrl }),
  };
}

function safeText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/(ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization\s*:\s*)?(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 2_000);
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubCheckRunError && error.code === "CHECKS_NOT_FOUND";
}

function isRetryable(error: unknown): boolean {
  return error instanceof GitHubCheckRunError && error.retryable;
}

async function storeRemoteIdentity(
  lock: DeploymentFeedbackLock,
  checkRunId: string,
): Promise<void> {
  const previous = lock.context?.checkRunId;
  if (previous !== null && previous !== undefined && previous !== checkRunId) {
    if (lock.replaceCheckRunId === undefined) {
      throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, 409);
    }
    await lock.replaceCheckRunId(previous, checkRunId);
    return;
  }
  await lock.storeCheckRunId(checkRunId);
}

function compareNumericIds(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
