import {
  createPrismaClient,
  DeploymentClaimRepository,
  DeploymentRepository,
  OutboxRelayRepository,
  ProjectRepository,
} from "@previewforge/database";
import type { EachMessagePayload } from "kafkajs";
import { resolveBuildInput } from "./build/build-input.js";
import { BuildKitAdapter } from "./build/buildkit-adapter.js";
import type { DeploymentBuildPipelineResult } from "./build/deployment-build-pipeline.js";
import { runDeploymentBuildPipeline } from "./build/deployment-build-pipeline.js";
import type { WorkerBuildConfig } from "./config.js";
import { loadWorkerConfig } from "./config.js";
import { handleDeploymentMessage } from "./deployment-consumer.js";
import { createKafkaClient, manualCommitRunOptions } from "./kafka/client.js";
import { ensureKafkaTopics } from "./kafka/topics.js";
import { createKubernetesResourceClient } from "./kubernetes/client.js";
import {
  createKubernetesReconciler,
  reconcilePreviewDeployment,
} from "./kubernetes/deployment-reconciler.js";
import { persistKubernetesFailure } from "./kubernetes/failure-persistence.js";
import { httpHealthCheck, resolveHealthCheckUrl } from "./kubernetes/rollout.js";
import { relayOutboxBatch } from "./outbox-relay.js";
import { GitHubInstallationTokenProvider } from "./source/github-installation-token.js";
import { GitHubSourceClient } from "./source/github-source.js";

const RELAY_POLL_INTERVAL_MS = 500;
const UNCOMMITTED_RETRY_DELAY_MS = 1_000;

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const prisma = createPrismaClient(config.databaseUrl);
  const claims = new DeploymentClaimRepository(prisma);
  const deployments = new DeploymentRepository(prisma);
  const projects = new ProjectRepository(prisma);
  const outbox = new OutboxRelayRepository(prisma);
  const kafka = createKafkaClient(config);
  const kubernetes =
    process.env.PREVIEWFORGE_KUBERNETES_ENABLED === "true"
      ? createKubernetesResourceClient()
      : undefined;
  const afterClaim = config.build
    ? createBuildAfterClaim({
        config: config.build,
        deployments,
        projects,
        ...(kubernetes === undefined ? {} : { kubernetes }),
      })
    : undefined;
  const controller = new AbortController();
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    safeLog({ event: "worker.stopping", signal });
    await kafka.consumer.stop().catch(() => undefined);
    await kafka.consumer.disconnect().catch(() => undefined);
    await Promise.allSettled([
      kafka.producer.disconnect(),
      kafka.admin.disconnect(),
      prisma.$disconnect(),
    ]);
    safeLog({ event: "worker.stopped", signal });
  };

  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

  await prisma.$connect();
  await kafka.admin.connect();
  await ensureKafkaTopics(kafka.admin, config);
  await kafka.admin.disconnect();
  await Promise.all([kafka.producer.connect(), kafka.consumer.connect()]);
  await kafka.consumer.subscribe({ topic: config.kafkaTopics.deploymentRequests });

  const relay = runRelayLoop(
    () => relayOutboxBatch(outbox, kafka.producer, { owner: config.kafkaClientId }),
    controller.signal,
  );

  safeLog({
    event: "worker.started",
    service: "previewforge-worker",
    consumerGroup: config.kafkaGroupId,
  });

  try {
    await kafka.consumer.run(
      manualCommitRunOptions((payload) =>
        consumeDeployment(payload, {
          claims,
          afterClaim,
          consumerName: config.kafkaGroupId,
          workerId: config.kafkaClientId,
          commitOffsets: (offsets) => kafka.consumer.commitOffsets(offsets),
        }),
      ),
    );
    await relay;
  } finally {
    await shutdown("SIGTERM");
  }
}

type ConsumerRuntime = {
  claims: DeploymentClaimRepository;
  consumerName: string;
  workerId: string;
  afterClaim?: Parameters<typeof handleDeploymentMessage>[1]["afterClaim"];
  commitOffsets: (
    offsets: Array<{ topic: string; partition: number; offset: string }>,
  ) => Promise<unknown>;
};

function createBuildAfterClaim(input: {
  config: WorkerBuildConfig;
  deployments: DeploymentRepository;
  projects: ProjectRepository;
  kubernetes?: ReturnType<typeof createKubernetesResourceClient>;
}): NonNullable<ConsumerRuntime["afterClaim"]> {
  const tokenProvider = new GitHubInstallationTokenProvider({
    appId: input.config.githubAppId,
    privateKey: input.config.githubPrivateKey,
    apiBaseUrl: input.config.githubApiBaseUrl,
  });
  const sourceClient = new GitHubSourceClient({
    apiBaseUrl: input.config.githubApiBaseUrl,
    tokenProvider: (installationId) => tokenProvider.getToken(installationId),
  });
  const buildkit = new BuildKitAdapter({ address: input.config.buildkitAddress });

  return async (event, claim) => {
    const project = await input.projects.findById(event.projectId);
    if (!project) {
      await input.deployments.transition({
        deploymentId: claim.deploymentId,
        expectedStatus: "CLONING",
        to: "FAILED",
        expectedDesiredSha: event.commitSha,
        failure: {
          stage: "SOURCE",
          code: "PROJECT_NOT_FOUND",
          message: "Deployment project configuration was not found",
          retryable: false,
        },
      });
      return "FAILED";
    }
    const buildInput = resolveBuildInput(event, project, {
      registryHost: input.config.registryHost,
    });
    const result: DeploymentBuildPipelineResult = await runDeploymentBuildPipeline(
      {
        deploymentId: claim.deploymentId,
        desiredSha: event.commitSha,
        ...buildInput,
      },
      { sourceClient, buildkit, deployments: input.deployments },
    );
    if (result.kind === "DEPLOYING" && input.kubernetes !== undefined) {
      try {
        const rolloutTimeoutMs = readOptionalDuration(
          "PREVIEWFORGE_ROLLOUT_TIMEOUT_MS",
          process.env.PREVIEWFORGE_ROLLOUT_TIMEOUT_MS,
        );
        const pollIntervalMs = readOptionalDuration(
          "PREVIEWFORGE_ROLLOUT_POLL_INTERVAL_MS",
          process.env.PREVIEWFORGE_ROLLOUT_POLL_INTERVAL_MS,
        );
        const healthCheckTimeoutMs = readOptionalDuration(
          "PREVIEWFORGE_HEALTHCHECK_TIMEOUT_MS",
          process.env.PREVIEWFORGE_HEALTHCHECK_TIMEOUT_MS,
        );
        const reconciliation = await reconcilePreviewDeployment(
          {
            event,
            imageReference: buildInput.imageReference,
            imageDigest: result.digest,
            containerPort: project.containerPort,
            healthPath: project.healthPath,
            ...(() => {
              const healthCheckUrl = resolveHealthCheckUrl(
                process.env.PREVIEWFORGE_HEALTHCHECK_URL_TEMPLATE,
                `preview-${event.environmentId}.previewforge.local`,
                project.healthPath,
              );
              return healthCheckUrl === undefined ? {} : { healthCheckUrl };
            })(),
            ...(rolloutTimeoutMs === undefined ? {} : { rolloutTimeoutMs }),
            ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
            ...(healthCheckTimeoutMs === undefined ? {} : { healthCheckTimeoutMs }),
          },
          {
            kubernetes: createKubernetesReconciler(input.kubernetes),
            deployments: input.deployments,
            rollout: { kubernetes: input.kubernetes, healthCheck: httpHealthCheck },
          },
        );
        if (reconciliation.kind === "SUPERSEDED") return "SUPERSEDED";
        if (reconciliation.kind === "FAILED") return "FAILED";
        return "PROCESSED";
      } catch (error) {
        return persistKubernetesFailure({
          deployments: input.deployments,
          deploymentId: claim.deploymentId,
          commitSha: event.commitSha,
          error,
        });
      }
    }
    if (result.kind === "DEPLOYING") return "PROCESSED";
    if (result.kind === "SUPERSEDED") return "SUPERSEDED";
    return "FAILED";
  };
}

function readOptionalDuration(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 24 * 60 * 60 * 1_000) {
    throw new Error(`Invalid worker configuration: ${name} is invalid`);
  }
  return parsed;
}

async function consumeDeployment(
  payload: EachMessagePayload,
  runtime: ConsumerRuntime,
): Promise<void> {
  const outcome = await handleDeploymentMessage(
    {
      topic: payload.topic,
      partition: payload.partition,
      offset: payload.message.offset,
      key: payload.message.key,
      value: payload.message.value,
      ...(payload.message.headers === undefined ? {} : { headers: payload.message.headers }),
    },
    {
      repository: runtime.claims,
      consumerName: runtime.consumerName,
      workerId: runtime.workerId,
      ...(runtime.afterClaim === undefined ? {} : { afterClaim: runtime.afterClaim }),
      offsets: {
        commitOffset: (offset) => runtime.commitOffsets([offset]),
      },
    },
  );

  safeLog({
    event: "worker.deployment-message",
    outcome: outcome.kind,
    committed: outcome.committed,
    ...(outcome.committed ? {} : { code: outcome.code }),
  });

  if (!outcome.committed) {
    // Stop the current batch before a later offset can be committed over the
    // deferred message. Kafka redelivers from the last durable group offset.
    await wait(UNCOMMITTED_RETRY_DELAY_MS);
    throw new Error(`deployment message deferred: ${outcome.code}`);
  }
}

async function runRelayLoop(
  relayBatch: () => Promise<{
    claimed: number;
    published: number;
    retryableFailures: number;
    deadLettered: number;
    failed: number;
  }>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await relayBatch();
      if (result.claimed > 0 || result.failed > 0) {
        safeLog({ event: "worker.outbox-batch", ...result });
      }
    } catch {
      safeLog({ event: "worker.outbox-batch", failed: 1, code: "OUTBOX_BATCH_FAILED" });
    }
    await waitForAbort(signal, RELAY_POLL_INTERVAL_MS);
  }
}

function safeLog(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

void main().catch((error: unknown) => {
  safeLog({
    event: "worker.fatal",
    code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
  });
  process.exitCode = 1;
});
