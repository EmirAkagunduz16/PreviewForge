import {
  createPrismaClient,
  DeploymentClaimRepository,
  DeploymentFeedbackRepository,
  DeploymentRepository,
  EnvironmentDeletionRepository,
  LogChunkRepository,
  OutboxRelayRepository,
  ProjectEnvironmentRepository,
  ProjectRepository,
} from "@previewforge/database";
import { CredentialCipher } from "@previewforge/security";
import type { EachMessagePayload } from "kafkajs";
import { resolveBuildInput } from "./build/build-input.js";
import { BuildKitAdapter } from "./build/buildkit-adapter.js";
import type { DeploymentBuildPipelineResult } from "./build/deployment-build-pipeline.js";
import { runDeploymentBuildPipeline } from "./build/deployment-build-pipeline.js";
import {
  type EnvironmentDeletionConsumerRecord,
  handleEnvironmentDeletionMessage,
} from "./cleanup/environment-deletion-consumer.js";
import { runOrphanSweeper } from "./cleanup/orphan-reconciler.js";
import { runTtlSweeper } from "./cleanup/ttl-sweeper.js";
import type { WorkerBuildConfig } from "./config.js";
import {
  DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  DEFAULT_TTL_SWEEP_INTERVAL_MS,
  loadWorkerConfig,
} from "./config.js";
import { handleDeploymentMessage } from "./deployment-consumer.js";
import { GitHubCheckRunClient } from "./github-checks/client.js";
import {
  type DeploymentFeedbackConsumerRecord,
  handleDeploymentFeedbackMessage,
} from "./github-checks/consumer.js";
import {
  GitHubCheckRunCoordinator as CheckRunCoordinator,
  type GitHubCheckRunCoordinator,
} from "./github-checks/coordinator.js";
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
import { loadPreviewUrlConfig, type PreviewUrlConfig, previewHostname } from "./preview-url.js";
import { loadProjectEnvironment } from "./runtime/project-environment.js";
import { GitHubInstallationTokenProvider } from "./source/github-installation-token.js";
import { GitHubSourceClient } from "./source/github-source.js";

const RELAY_POLL_INTERVAL_MS = 500;
const UNCOMMITTED_RETRY_DELAY_MS = 1_000;

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const previewUrlConfig = loadPreviewUrlConfig(process.env, config.nodeEnv);
  const prisma = createPrismaClient(config.databaseUrl);
  const claims = new DeploymentClaimRepository(prisma);
  const feedbackRepository = new DeploymentFeedbackRepository(prisma);
  const deletionRepository = new EnvironmentDeletionRepository(prisma);
  const deployments = new DeploymentRepository(prisma);
  const logChunks = new LogChunkRepository(prisma);
  const projects = new ProjectRepository(prisma);
  const projectEnvironments = new ProjectEnvironmentRepository(prisma);
  const outbox = new OutboxRelayRepository(prisma);
  const kafka = createKafkaClient(config);
  const kubernetes =
    process.env.PREVIEWFORGE_KUBERNETES_ENABLED === "true"
      ? createKubernetesResourceClient()
      : undefined;
  const cleanupReconciler =
    kubernetes === undefined ? undefined : createKubernetesReconciler(kubernetes);
  const afterClaim = config.build
    ? createBuildAfterClaim({
        config: config.build,
        previewBaseDomain: previewUrlConfig.baseDomain,
        deployments,
        logChunks,
        projects,
        projectEnvironments,
        ...(config.encryptionKey === undefined
          ? {}
          : { cipher: new CredentialCipher(config.encryptionKey) }),
        ...(kubernetes === undefined ? {} : { kubernetes }),
      })
    : undefined;
  const checkRunCoordinator = config.build
    ? createCheckRunCoordinator({
        config: config.build,
        repository: feedbackRepository,
        previewUrlConfig,
        consumerName: `${config.kafkaGroupId}:github-checks`,
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
    await kafka.feedbackConsumer.stop().catch(() => undefined);
    await kafka.feedbackConsumer.disconnect().catch(() => undefined);
    await kafka.cleanupConsumer.stop().catch(() => undefined);
    await kafka.cleanupConsumer.disconnect().catch(() => undefined);
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
  await Promise.all([
    kafka.producer.connect(),
    kafka.consumer.connect(),
    ...(checkRunCoordinator === undefined ? [] : [kafka.feedbackConsumer.connect()]),
    ...(cleanupReconciler === undefined ? [] : [kafka.cleanupConsumer.connect()]),
  ]);
  await kafka.consumer.subscribe({ topic: config.kafkaTopics.deploymentRequests });
  if (checkRunCoordinator !== undefined) {
    await kafka.feedbackConsumer.subscribe({ topic: config.kafkaTopics.deploymentRequests });
    await kafka.feedbackConsumer.subscribe({ topic: config.kafkaTopics.deploymentEvents });
  }
  if (cleanupReconciler !== undefined) {
    await kafka.cleanupConsumer.subscribe({ topic: config.kafkaTopics.environmentCommands });
  }

  const relay = runRelayLoop(
    () => relayOutboxBatch(outbox, kafka.producer, { owner: config.kafkaClientId }),
    controller.signal,
  );
  const ttlSweep = runTtlSweeper(deletionRepository, {
    intervalMs: config.ttlSweepIntervalMs ?? DEFAULT_TTL_SWEEP_INTERVAL_MS,
    signal: controller.signal,
    onSweep: (result) =>
      safeLog({
        event: "worker.ttl-sweep.completed",
        scanned: result.scanned,
        enqueued: result.enqueued,
        skipped: result.skipped,
      }),
    onError: () => safeLog({ event: "worker.ttl-sweep.failed" }),
  });
  const orphanSweep =
    kubernetes === undefined || cleanupReconciler === undefined
      ? Promise.resolve()
      : runOrphanSweeper(
          {
            kubernetes,
            database: deletionRepository,
            deleteNamespace: (environmentId) =>
              cleanupReconciler.deletePreviewNamespace(environmentId),
          },
          {
            intervalMs: config.orphanSweepIntervalMs ?? DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
            signal: controller.signal,
            onSweep: (result) =>
              safeLog({
                event: "worker.orphan-sweep.completed",
                pages: result.pages,
                scanned: result.scanned,
                deleted: result.deleted,
                skipped: result.skipped,
                failed: result.failed,
                truncated: result.truncated,
              }),
            onError: () => safeLog({ event: "worker.orphan-sweep.failed" }),
          },
        );

  safeLog({
    event: "worker.started",
    service: "previewforge-worker",
    consumerGroup: config.kafkaGroupId,
  });

  try {
    const deploymentRun = kafka.consumer.run(
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
    const feedbackRun =
      checkRunCoordinator === undefined
        ? Promise.resolve()
        : kafka.feedbackConsumer.run(
            manualCommitRunOptions((payload) =>
              consumeDeploymentFeedback(payload, {
                repository: feedbackRepository,
                coordinator: checkRunCoordinator,
                consumerName: `${config.kafkaGroupId}:github-checks`,
                commitOffsets: (offsets) => kafka.feedbackConsumer.commitOffsets(offsets),
              }),
            ),
          );
    const cleanupRun =
      cleanupReconciler === undefined
        ? Promise.resolve()
        : kafka.cleanupConsumer.run(
            manualCommitRunOptions((payload) =>
              consumeEnvironmentDeletion(payload, {
                repository: deletionRepository,
                deliveryRepository: feedbackRepository,
                deleteNamespace: (environmentId) =>
                  cleanupReconciler.deletePreviewNamespace(environmentId),
                consumerName: `${config.kafkaGroupId}:environment-cleanup`,
                commitOffsets: (offsets) => kafka.cleanupConsumer.commitOffsets(offsets),
              }),
            ),
          );
    await Promise.all([deploymentRun, feedbackRun, cleanupRun, relay, ttlSweep, orphanSweep]);
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

type FeedbackConsumerRuntime = {
  repository: DeploymentFeedbackRepository;
  coordinator: GitHubCheckRunCoordinator;
  consumerName: string;
  commitOffsets: (
    offsets: Array<{ topic: string; partition: number; offset: string }>,
  ) => Promise<unknown>;
};

type EnvironmentDeletionConsumerRuntime = {
  repository: EnvironmentDeletionRepository;
  deliveryRepository: DeploymentFeedbackRepository;
  deleteNamespace: (environmentId: string) => Promise<void>;
  consumerName: string;
  commitOffsets: (
    offsets: Array<{ topic: string; partition: number; offset: string }>,
  ) => Promise<unknown>;
};

function createCheckRunCoordinator(input: {
  config: WorkerBuildConfig;
  repository: DeploymentFeedbackRepository;
  previewUrlConfig: PreviewUrlConfig;
  consumerName: string;
}): GitHubCheckRunCoordinator {
  const tokenProvider = new GitHubInstallationTokenProvider({
    appId: input.config.githubAppId,
    privateKey: input.config.githubPrivateKey,
    apiBaseUrl: input.config.githubApiBaseUrl,
  });
  const client = new GitHubCheckRunClient({
    apiBaseUrl: input.config.githubApiBaseUrl,
    tokenProvider: (installationId) => tokenProvider.getToken(installationId),
  });
  return new CheckRunCoordinator({
    repository: input.repository,
    client,
    previewUrlConfig: input.previewUrlConfig,
    consumerName: input.consumerName,
  });
}

function createBuildAfterClaim(input: {
  config: WorkerBuildConfig;
  previewBaseDomain: string;
  deployments: DeploymentRepository;
  logChunks: LogChunkRepository;
  projects: ProjectRepository;
  projectEnvironments: ProjectEnvironmentRepository;
  cipher?: CredentialCipher;
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
      { sourceClient, buildkit, deployments: input.deployments, logChunks: input.logChunks },
    );
    if (result.kind === "DEPLOYING" && input.kubernetes !== undefined) {
      try {
        if (input.cipher === undefined)
          throw new Error("Worker environment encryption is not configured");
        const environment = await loadProjectEnvironment(
          input.projectEnvironments,
          input.cipher,
          event.projectId,
        );
        const expiresAt = await input.projectEnvironments.findPreviewExpiryByEnvironmentId(
          event.environmentId,
        );
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
            previewBaseDomain: input.previewBaseDomain,
            ...(() => {
              const healthCheckUrl = resolveHealthCheckUrl(
                process.env.PREVIEWFORGE_HEALTHCHECK_URL_TEMPLATE,
                previewHostname(event.environmentId, input.previewBaseDomain),
                project.healthPath,
              );
              return healthCheckUrl === undefined ? {} : { healthCheckUrl };
            })(),
            ...(rolloutTimeoutMs === undefined ? {} : { rolloutTimeoutMs }),
            ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
            ...(healthCheckTimeoutMs === undefined ? {} : { healthCheckTimeoutMs }),
            expiresAt,
            environment,
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

async function consumeDeploymentFeedback(
  payload: EachMessagePayload,
  runtime: FeedbackConsumerRuntime,
): Promise<void> {
  const record: DeploymentFeedbackConsumerRecord = {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    key: payload.message.key,
    value: payload.message.value,
    ...(payload.message.headers === undefined ? {} : { headers: payload.message.headers }),
  };
  const outcome = await handleDeploymentFeedbackMessage(record, {
    repository: runtime.repository,
    coordinator: runtime.coordinator,
    consumerName: runtime.consumerName,
    offsets: { commitOffset: (offset) => runtime.commitOffsets([offset]) },
  });
  safeLog({
    event: "worker.github-check-message",
    outcome: outcome.kind,
    committed: outcome.committed,
    ...(outcome.committed ? {} : { code: outcome.code }),
  });
  if (!outcome.committed) {
    await wait(UNCOMMITTED_RETRY_DELAY_MS);
    throw new Error(`GitHub Check Run message deferred: ${outcome.code}`);
  }
}

async function consumeEnvironmentDeletion(
  payload: EachMessagePayload,
  runtime: EnvironmentDeletionConsumerRuntime,
): Promise<void> {
  const record: EnvironmentDeletionConsumerRecord = {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    key: payload.message.key,
    value: payload.message.value,
    ...(payload.message.headers === undefined ? {} : { headers: payload.message.headers }),
  };
  const outcome = await handleEnvironmentDeletionMessage(record, {
    repository: runtime.repository,
    deliveryRepository: runtime.deliveryRepository,
    deleteNamespace: runtime.deleteNamespace,
    consumerName: runtime.consumerName,
    offsets: { commitOffset: (offset) => runtime.commitOffsets([offset]) },
  });
  safeLog({
    event: "worker.environment-deletion-message",
    outcome: outcome.kind,
    committed: outcome.committed,
    ...(outcome.committed ? {} : { code: outcome.code }),
  });
  if (!outcome.committed) {
    await wait(UNCOMMITTED_RETRY_DELAY_MS);
    throw new Error(`Environment deletion message deferred: ${outcome.code}`);
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
