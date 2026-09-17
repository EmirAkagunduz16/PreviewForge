import { randomUUID } from "node:crypto";
import type {
  DeploymentRequested,
  EnvironmentDeletionRequested,
  KafkaEvent,
} from "@previewforge/contracts";
import {
  createPrismaClient,
  DeploymentClaimRepository,
  DeploymentFeedbackRepository,
  DeploymentRepository,
  EnvironmentDeletionRepository,
  OutboxRelayRepository,
  type PrismaClient,
} from "@previewforge/database";
import { type Admin, type Consumer, type EachMessagePayload, Kafka, type Producer } from "kafkajs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleEnvironmentDeletionMessage } from "./cleanup/environment-deletion-consumer.js";
import { DEFAULT_KAFKA_TOPICS, type WorkerConfig } from "./config.js";
import { type DeploymentConsumerOutcome, handleDeploymentMessage } from "./deployment-consumer.js";
import { GitHubCheckRunClient } from "./github-checks/client.js";
import { handleDeploymentFeedbackMessage } from "./github-checks/consumer.js";
import {
  type DeploymentFeedbackEvent,
  GitHubCheckRunCoordinator,
} from "./github-checks/coordinator.js";
import {
  consumerOptions,
  kafkaClientOptions,
  manualCommitRunOptions,
  producerOptions,
  producerSendOptions,
} from "./kafka/client.js";
import { ensureKafkaTopics } from "./kafka/topics.js";
import {
  type ControlledCheckRunServer,
  startControlledCheckRunServer,
} from "./m8-faults/controlled-checks.js";
import { relayOutboxBatch } from "./outbox-relay.js";

const databaseUrl = process.env.DATABASE_URL;
const kafkaBrokers = process.env.KAFKA_BROKERS?.split(",").map((value) => value.trim());
if (!databaseUrl) throw new Error("DATABASE_URL is required for M8 worker acceptance");
if (!kafkaBrokers?.length || kafkaBrokers.some((value) => value.length === 0)) {
  throw new Error("KAFKA_BROKERS is required for M8 worker acceptance");
}

const runId = randomUUID();
const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl,
  kafkaBrokers,
  kafkaClientId: `m8-acceptance-${runId}`,
  kafkaGroupId: `m8-acceptance-${runId}`,
  kafkaTopics: DEFAULT_KAFKA_TOPICS,
};

type WorkerFixture = {
  userId: string;
  projectId: string;
  installationId: string;
  environmentId: string;
  deploymentId: string;
  pullRequestId: string;
  commitSha: string;
  event: DeploymentRequested;
};

describe("M8 worker Kafka, feedback, and cleanup fault matrix", () => {
  let prisma: PrismaClient;
  let producer: Producer;
  let admin: Admin;
  let checkServer: ControlledCheckRunServer;
  const consumers: Consumer[] = [];
  const groups: string[] = [];
  const fixtures: WorkerFixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    const kafka = new Kafka(kafkaClientOptions(config));
    producer = kafka.producer(producerOptions());
    admin = kafka.admin();
    await prisma.$connect();
    await admin.connect();
    await ensureKafkaTopics(admin, config);
    await producer.connect();
    checkServer = await startControlledCheckRunServer();
  });

  afterEach(async () => {
    await Promise.allSettled(consumers.splice(0).map((consumer) => consumer.disconnect()));
    for (const fixture of fixtures) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: [fixture.deploymentId, fixture.environmentId] } },
      });
    }
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      await Promise.allSettled(consumers.splice(0).map((consumer) => consumer.disconnect()));
      if (checkServer) await checkServer.close();
      if (producer) await producer.disconnect();
      if (groups.length > 0) await admin.deleteGroups(groups).catch(() => undefined);
      if (admin) await admin.disconnect();
      if (groups.length > 0) {
        await prisma.consumerReceipt.deleteMany({ where: { consumerName: { in: groups } } });
        await prisma.kafkaDelivery.deleteMany({ where: { consumerName: { in: groups } } });
      }

      for (const fixture of fixtures) {
        const aggregateIds = [fixture.deploymentId, fixture.environmentId];
        const outbox = await prisma.outboxEvent.findMany({
          where: { aggregateId: { in: aggregateIds } },
          select: { id: true },
        });
        const eventIds = [fixture.event.eventId, ...outbox.map((event) => event.id)];
        await prisma.consumerReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.kafkaDelivery.deleteMany({
          where: { OR: [{ aggregateId: { in: aggregateIds } }, { eventId: { in: eventIds } }] },
        });
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
        await prisma.user.deleteMany({ where: { id: fixture.userId } });
      }
      const fixtureUserIds = fixtures.map((fixture) => fixture.userId);
      const fixtureEnvironmentIds = fixtures.map((fixture) => fixture.environmentId);
      const fixtureDeploymentIds = fixtures.map((fixture) => fixture.deploymentId);
      expect(await prisma.user.count({ where: { id: { in: fixtureUserIds } } })).toBe(0);
      expect(
        await prisma.previewEnvironment.count({ where: { id: { in: fixtureEnvironmentIds } } }),
      ).toBe(0);
      expect(await prisma.deployment.count({ where: { id: { in: fixtureDeploymentIds } } })).toBe(
        0,
      );
      expect(
        await prisma.outboxEvent.count({
          where: { aggregateId: { in: [...fixtureEnvironmentIds, ...fixtureDeploymentIds] } },
        }),
      ).toBe(0);
      expect(
        await prisma.kafkaDelivery.count({
          where: { aggregateId: { in: [...fixtureEnvironmentIds, ...fixtureDeploymentIds] } },
        }),
      ).toBe(0);
      if (groups.length > 0) {
        expect(
          await prisma.consumerReceipt.count({ where: { consumerName: { in: groups } } }),
        ).toBe(0);
        expect(await prisma.kafkaDelivery.count({ where: { consumerName: { in: groups } } })).toBe(
          0,
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      if (prisma) await prisma.$disconnect();
    }
    if (cleanupError !== undefined) throw cleanupError;
  }, 60_000);

  it("replays an outbox event after broker acknowledgement and mark-published crash", async () => {
    const fixture = await createFixture({ withOutbox: true });
    fixtures.push(fixture);
    const observed: string[] = [];
    const observer = await startConsumer(
      `m8-relay-observer-${runId}`,
      config.kafkaTopics.deploymentRequests,
      async ({ message }) => {
        if (message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          observed.push(message.offset);
        }
      },
    );
    consumers.push(observer);

    const repository = new OutboxRelayRepository(prisma);
    const crashRepository = {
      claimBatch: repository.claimBatch.bind(repository),
      recordFailure: repository.recordFailure.bind(repository),
      markPublished: async () => {
        throw new Error("m8 injected after Kafka acknowledgement");
      },
    };
    await expect(
      relayOutboxBatch(crashRepository, producer, {
        owner: `m8-relay-crash-${runId}`,
        batchSize: 1,
        leaseDurationMs: 40,
        maxAttempts: 3,
      }),
    ).resolves.toMatchObject({ claimed: 1, published: 0, failed: 1 });
    await waitFor(() => observed.length >= 1, "first outbox Kafka publish");
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: fixture.event.eventId } }),
    ).toMatchObject({
      attempts: 1,
      publishedAt: null,
    });

    await waitForOutboxLeaseExpiry(prisma, fixture.event.eventId);
    await expect(
      relayOutboxBatch(repository, producer, {
        owner: `m8-relay-restarted-${runId}`,
        batchSize: 1,
        leaseDurationMs: 10_000,
        maxAttempts: 3,
      }),
    ).resolves.toMatchObject({ claimed: 1, published: 1, failed: 0 });
    await waitFor(() => observed.length >= 2, "replayed outbox Kafka publish");
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: fixture.event.eventId } }),
    ).toMatchObject({
      attempts: 2,
      publishedAt: expect.any(Date),
      claimToken: null,
    });
  }, 30_000);

  it("redelivers after a worker crash between the DB commit and Kafka offset commit", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const groupId = `m8-worker-crash-${runId}`;
    const claims = new DeploymentClaimRepository(prisma);
    const firstOutcome = deferred<DeploymentConsumerOutcome>();
    let firstConsumer: Consumer;
    firstConsumer = await startConsumer(
      groupId,
      config.kafkaTopics.deploymentRequests,
      async (payload) => {
        const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: claims,
          consumerName: groupId,
          workerId: `m8-worker-before-crash-${runId}`,
          offsets: kafkaOffsetCommitter(firstConsumer),
          afterDatabaseCommitBeforeOffsetCommit: async () => {
            throw new Error("m8 injected before Kafka offset commit");
          },
        });
        if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          firstOutcome.resolve(outcome);
          if (!outcome.committed) throw new Error("stop after injected worker crash");
        }
      },
    );
    consumers.push(firstConsumer);
    await publishDeployment(fixture.event);
    await expect(withTimeout(firstOutcome.promise, "first worker crash outcome")).resolves.toEqual({
      kind: "FAILED",
      committed: false,
      code: "OFFSET_COMMIT_DEFERRED",
    });
    await firstConsumer.disconnect();
    expect(
      await prisma.consumerReceipt.count({
        where: { consumerName: groupId, eventId: fixture.event.eventId },
      }),
    ).toBe(1);
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({ status: "CLONING" });

    const secondOutcome = deferred<DeploymentConsumerOutcome>();
    const secondConsumer = await startConsumer(
      groupId,
      config.kafkaTopics.deploymentRequests,
      async (payload) => {
        const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: claims,
          consumerName: groupId,
          workerId: `m8-worker-after-crash-${runId}`,
          offsets: kafkaOffsetCommitter(secondConsumer),
        });
        if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          secondOutcome.resolve(outcome);
        }
      },
      false,
    );
    consumers.push(secondConsumer);
    await expect(withTimeout(secondOutcome.promise, "worker redelivery")).resolves.toMatchObject({
      kind: "ALREADY_PROCESSED",
      committed: true,
    });
    expect(
      await prisma.consumerReceipt.count({
        where: { consumerName: groupId, eventId: fixture.event.eventId },
      }),
    ).toBe(1);
  }, 40_000);

  it("fences a stale desired SHA before acquiring a deployment lease", async () => {
    const fixture = await createFixture({ desiredSha: "f".repeat(40) });
    fixtures.push(fixture);
    const groupId = `m8-stale-${runId}`;
    const outcome = deferred<DeploymentConsumerOutcome>();
    let consumer: Consumer;
    consumer = await startConsumer(
      groupId,
      config.kafkaTopics.deploymentRequests,
      async (payload) => {
        const result = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: new DeploymentClaimRepository(prisma),
          consumerName: groupId,
          workerId: `m8-stale-worker-${runId}`,
          offsets: kafkaOffsetCommitter(consumer),
        });
        if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          outcome.resolve(result);
        }
      },
    );
    consumers.push(consumer);
    await publishDeployment(fixture.event);
    await expect(withTimeout(outcome.promise, "stale SHA outcome")).resolves.toEqual({
      kind: "SUPERSEDED",
      committed: true,
    });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "SUPERSEDED",
      leaseToken: null,
      leaseOwner: null,
    });
    expect(
      await prisma.consumerReceipt.count({
        where: { consumerName: groupId, eventId: fixture.event.eventId },
      }),
    ).toBe(1);
  }, 30_000);

  it("persists a retry window and completes it after the delivery becomes due", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const groupId = `m8-retry-${runId}`;
    const claims = new DeploymentClaimRepository(prisma);
    let injectFailure = true;
    const retryRepository = {
      claimRequestedDeployment: async (
        input: Parameters<DeploymentClaimRepository["claimRequestedDeployment"]>[0],
      ) => {
        if (injectFailure) {
          injectFailure = false;
          throw Object.assign(new Error("m8 injected transient claim failure"), {
            retriable: true,
          });
        }
        return claims.claimRequestedDeployment(input);
      },
      recordDeadLetter: claims.recordDeadLetter.bind(claims),
      scheduleRetry: claims.scheduleRetry.bind(claims),
    };
    const firstOutcome = deferred<DeploymentConsumerOutcome>();
    let firstConsumer: Consumer;
    firstConsumer = await startConsumer(
      groupId,
      config.kafkaTopics.deploymentRequests,
      async (payload) => {
        const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: retryRepository,
          consumerName: groupId,
          workerId: `m8-retry-worker-${runId}`,
          offsets: kafkaOffsetCommitter(firstConsumer),
          maxAttempts: 3,
          retryBaseDelayMs: 20,
          retryMaxDelayMs: 20,
        });
        if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          firstOutcome.resolve(outcome);
        }
      },
    );
    consumers.push(firstConsumer);
    await publishDeployment(fixture.event);
    await expect(withTimeout(firstOutcome.promise, "retry scheduling")).resolves.toMatchObject({
      kind: "RETRY_SCHEDULED",
      committed: false,
    });
    await firstConsumer.disconnect();
    await waitForKafkaDeliveryDue(prisma, groupId, fixture.event.eventId);

    const secondOutcome = deferred<DeploymentConsumerOutcome>();
    let secondConsumer: Consumer;
    secondConsumer = await startConsumer(
      groupId,
      config.kafkaTopics.deploymentRequests,
      async (payload) => {
        const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: claims,
          consumerName: groupId,
          workerId: `m8-retry-worker-restarted-${runId}`,
          offsets: kafkaOffsetCommitter(secondConsumer),
          maxAttempts: 3,
          retryBaseDelayMs: 20,
          retryMaxDelayMs: 20,
        });
        if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          secondOutcome.resolve(outcome);
        }
      },
      false,
    );
    consumers.push(secondConsumer);
    await expect(withTimeout(secondOutcome.promise, "retry redelivery")).resolves.toMatchObject({
      kind: "PROCESSED",
      committed: true,
    });
    expect(
      await prisma.kafkaDelivery.findFirst({
        where: { consumerName: groupId, eventId: fixture.event.eventId },
      }),
    ).toMatchObject({
      status: "PROCESSED",
      attempts: 2,
    });
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({ status: "CLONING" });
  }, 30_000);

  it("recovers a lost Check Run create response through the real feedback consumer", async () => {
    const fixture = await createFixture({ withPullRequest: true });
    fixtures.push(fixture);
    const secret = `ghp_m8-feedback-secret-${runId}`;
    const transition = await new DeploymentRepository(prisma).transition({
      deploymentId: fixture.deploymentId,
      expectedStatus: "QUEUED",
      to: "FAILED",
      expectedDesiredSha: fixture.commitSha,
      failure: {
        stage: "BUILD",
        code: "BUILD_FAILED",
        message: `token ${secret}`,
        retryable: false,
      },
    });
    expect(transition.applied).toBe(true);
    if (!transition.applied) return;
    const row = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: transition.outboxEventId },
    });
    const feedbackEvent = row.payload as DeploymentFeedbackEvent;
    const groupId = `m8-feedback-${runId}`;
    const feedbackRepository = new DeploymentFeedbackRepository(prisma);
    const client = new GitHubCheckRunClient({
      apiBaseUrl: checkServer.origin,
      tokenProvider: async () => `ghs_m8_feedback_token_${runId}`,
      timeoutMs: 2_000,
    });
    const coordinator = new GitHubCheckRunCoordinator({
      repository: feedbackRepository,
      client,
      previewUrlConfig: { baseDomain: "m8.preview.test", scheme: "http" },
      consumerName: groupId,
    });
    const outcome = deferred<Awaited<ReturnType<typeof handleDeploymentFeedbackMessage>>>();
    let consumer: Consumer;
    consumer = await startConsumer(
      groupId,
      config.kafkaTopics.deploymentEvents,
      async (payload) => {
        const result = await handleDeploymentFeedbackMessage(toFeedbackRecord(payload), {
          repository: feedbackRepository,
          coordinator,
          consumerName: groupId,
          offsets: kafkaOffsetCommitter(consumer),
        });
        if (payload.message.headers?.["event-id"]?.toString() === transition.outboxEventId) {
          outcome.resolve(result);
        }
      },
    );
    consumers.push(consumer);
    await expect(
      relayOutboxBatch(new OutboxRelayRepository(prisma), producer, {
        owner: `m8-feedback-relay-${runId}`,
        batchSize: 1,
      }),
    ).resolves.toMatchObject({ claimed: 1, published: 1 });
    await expect(withTimeout(outcome.promise, "GitHub feedback processing")).resolves.toEqual({
      kind: "PROCESSED",
      committed: true,
    });

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: fixture.deploymentId },
    });
    expect(deployment.checkRunId).toBe("5800008");
    expect(deployment.failureMessage).toBe("token [REDACTED]");
    expect(checkServer.created).toHaveLength(1);
    expect(checkServer.updated).toHaveLength(1);
    expect(checkServer.rawRequestBodies.join("\n")).not.toContain(secret);
    expect(JSON.stringify(deployment, bigintJson)).not.toContain(secret);
    await expect(coordinator.process(feedbackEvent)).resolves.toBe("DUPLICATE");
  }, 30_000);

  it("retries interrupted cleanup and never invokes a delete for a completed request", async () => {
    const fixture = await createFixture({ withPullRequest: true, pullRequestState: "CLOSED" });
    fixtures.push(fixture);
    const requestId = randomUUID();
    const event: EnvironmentDeletionRequested = {
      eventId: randomUUID(),
      eventType: "environment.deletion-requested.v1",
      occurredAt: new Date().toISOString(),
      environmentId: fixture.environmentId,
      sourceTimestamp: new Date().toISOString(),
      projectId: fixture.projectId,
      pullRequestId: fixture.pullRequestId,
      pullRequestNumber: 8,
      repositoryId: await repositoryId(prisma, fixture.projectId),
      repositoryFullName: await repositoryName(prisma, fixture.projectId),
      installationId: await installationId(prisma, fixture.projectId),
      reason: "pull_request_closed",
    };
    await prisma.environmentDeletionRequest.create({
      data: {
        id: requestId,
        environmentId: fixture.environmentId,
        requestKey: `environment:${fixture.environmentId}`,
        status: "REQUESTED",
        reason: "pull_request_closed",
        sourceUpdatedAt: new Date(event.sourceTimestamp),
        sourceDeliveryId: `m8-cleanup-${runId}`,
      },
    });

    let deleteCalls = 0;
    const repository = new EnvironmentDeletionRepository(prisma);
    const groupId = `m8-cleanup-${runId}`;
    const firstOutcome = deferred<Awaited<ReturnType<typeof handleEnvironmentDeletionMessage>>>();
    let firstConsumer: Consumer;
    firstConsumer = await startConsumer(
      groupId,
      config.kafkaTopics.environmentCommands,
      async (payload) => {
        const outcome = await handleEnvironmentDeletionMessage(toDeletionRecord(payload), {
          repository,
          deliveryRepository: new DeploymentFeedbackRepository(prisma),
          consumerName: groupId,
          deleteNamespace: async () => {
            deleteCalls += 1;
            if (deleteCalls === 1)
              throw Object.assign(new Error("m8 cleanup interruption"), { retryable: true });
          },
          offsets: kafkaOffsetCommitter(firstConsumer),
          maxAttempts: 3,
          retryBaseDelayMs: 20,
          retryMaxDelayMs: 20,
        });
        if (payload.message.headers?.["event-id"]?.toString() === event.eventId)
          firstOutcome.resolve(outcome);
      },
    );
    consumers.push(firstConsumer);
    await publishEvent(config.kafkaTopics.environmentCommands, event.environmentId, event);
    await expect(
      withTimeout(firstOutcome.promise, "cleanup retry scheduling"),
    ).resolves.toMatchObject({
      kind: "RETRY_SCHEDULED",
      committed: false,
    });
    await firstConsumer.disconnect();
    await waitForKafkaDeliveryDue(prisma, groupId, event.eventId);

    const secondOutcome = deferred<Awaited<ReturnType<typeof handleEnvironmentDeletionMessage>>>();
    let secondConsumer: Consumer;
    secondConsumer = await startConsumer(
      groupId,
      config.kafkaTopics.environmentCommands,
      async (payload) => {
        const outcome = await handleEnvironmentDeletionMessage(toDeletionRecord(payload), {
          repository,
          deliveryRepository: new DeploymentFeedbackRepository(prisma),
          consumerName: groupId,
          deleteNamespace: async () => {
            deleteCalls += 1;
          },
          offsets: kafkaOffsetCommitter(secondConsumer),
          maxAttempts: 3,
          retryBaseDelayMs: 20,
          retryMaxDelayMs: 20,
        });
        if (payload.message.headers?.["event-id"]?.toString() === event.eventId)
          secondOutcome.resolve(outcome);
      },
      false,
    );
    consumers.push(secondConsumer);
    await expect(withTimeout(secondOutcome.promise, "cleanup redelivery")).resolves.toMatchObject({
      kind: "PROCESSED",
      committed: true,
    });
    expect(deleteCalls).toBe(2);
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: requestId } }),
    ).toMatchObject({
      status: "COMPLETED",
      failureReason: null,
    });
    await expect(
      repository.process({
        event,
        deleteNamespace: async () => {
          throw new Error("must not delete completed request");
        },
      }),
    ).resolves.toMatchObject({ kind: "SKIPPED", reason: "ALREADY_COMPLETED" });
    expect(deleteCalls).toBe(2);
  }, 30_000);

  async function createFixture(
    options: {
      desiredSha?: string;
      withOutbox?: boolean;
      withPullRequest?: boolean;
      pullRequestState?: "OPEN" | "CLOSED";
    } = {},
  ): Promise<WorkerFixture> {
    const suffix = randomUUID();
    const userId = randomUUID();
    const installationId = randomUUID();
    const projectId = randomUUID();
    const pullRequestId = randomUUID();
    const environmentId = randomUUID();
    const deploymentId = randomUUID();
    const eventId = randomUUID();
    const commitSha = `${suffix.replaceAll("-", "")}${"0".repeat(40)}`.slice(0, 40);
    const githubInstallationId = (BigInt(Date.now()) + BigInt(fixtures.length + 1)).toString();
    const repositoryFullName = `previewforge/m8-worker-${suffix}`;
    await prisma.user.create({
      data: { id: userId, githubUserId: `m8-worker-${suffix}`, githubLogin: `m8-${suffix}` },
    });
    await prisma.installation.create({
      data: {
        id: installationId,
        githubInstallationId: BigInt(githubInstallationId),
        accountLogin: `m8-${suffix}`,
        accountType: "User",
        ownerId: userId,
      },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        installationId,
        ownerId: userId,
        githubRepositoryId: BigInt(githubInstallationId) + 100_000n,
        repositoryFullName,
      },
    });
    if (options.withPullRequest) {
      await prisma.pullRequest.create({
        data: {
          id: pullRequestId,
          projectId,
          number: 8,
          title: "M8 worker fixture",
          headSha: commitSha,
          state: options.pullRequestState ?? "OPEN",
        },
      });
    }
    await prisma.previewEnvironment.create({
      data: {
        id: environmentId,
        projectId,
        ...(options.withPullRequest ? { pullRequestId } : {}),
        previewKey: `m8-worker-${suffix}`,
        desiredCommitSha: options.desiredSha ?? commitSha,
      },
    });
    await prisma.deployment.create({ data: { id: deploymentId, environmentId, commitSha } });
    const event: DeploymentRequested = {
      eventId,
      eventType: "deployment.requested.v1",
      occurredAt: new Date().toISOString(),
      deploymentId,
      environmentId,
      projectId,
      installationId: githubInstallationId,
      repositoryFullName,
      pullRequestNumber: 8,
      commitSha,
    };
    if (options.withOutbox) {
      await prisma.outboxEvent.create({
        data: {
          id: eventId,
          eventType: event.eventType,
          aggregateType: "deployment",
          aggregateId: deploymentId,
          payload: event,
        },
      });
    }
    return {
      userId,
      projectId,
      installationId,
      environmentId,
      deploymentId,
      pullRequestId,
      commitSha,
      event,
    };
  }

  async function publishDeployment(event: DeploymentRequested): Promise<void> {
    await publishEvent(config.kafkaTopics.deploymentRequests, event.environmentId, event);
  }

  async function publishEvent(topic: string, key: string, event: KafkaEvent): Promise<void> {
    await producer.send(
      producerSendOptions(topic, [
        {
          key,
          value: JSON.stringify(event),
          headers: { "event-id": event.eventId, "event-type": event.eventType },
        },
      ]),
    );
  }

  async function startConsumer(
    groupId: string,
    topic: string,
    handler: (payload: EachMessagePayload) => Promise<void>,
    seedOffsets = true,
  ): Promise<Consumer> {
    if (seedOffsets) await seedGroupAtTopicEnd(admin, groupId, topic);
    groups.push(groupId);
    const kafka = new Kafka(kafkaClientOptions({ ...config, kafkaGroupId: groupId }));
    const consumer = kafka.consumer(consumerOptions({ ...config, kafkaGroupId: groupId }));
    const joined = deferred<void>();
    consumer.on(consumer.events.GROUP_JOIN, () => joined.resolve());
    await consumer.connect();
    await consumer.subscribe({ topic });
    await consumer.run(manualCommitRunOptions(handler));
    await withTimeout(joined.promise, `consumer group join ${groupId}`, 15_000);
    return consumer;
  }
});

function toConsumerRecord(payload: EachMessagePayload) {
  return {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    key: payload.message.key,
    value: payload.message.value,
    ...(payload.message.headers === undefined ? {} : { headers: payload.message.headers }),
  };
}

function toFeedbackRecord(payload: EachMessagePayload) {
  return toConsumerRecord(payload);
}

function toDeletionRecord(payload: EachMessagePayload) {
  return toConsumerRecord(payload);
}

function kafkaOffsetCommitter(consumer: Consumer) {
  return {
    commitOffset: (offset: { topic: string; partition: number; offset: string }) =>
      consumer.commitOffsets([offset]),
  };
}

async function seedGroupAtTopicEnd(admin: Admin, groupId: string, topic: string): Promise<void> {
  const offsets = await admin.fetchTopicOffsets(topic);
  await admin.setOffsets({
    groupId,
    topic,
    partitions: offsets.map(({ partition, offset }) => ({ partition, offset })),
  });
}

async function waitForOutboxLeaseExpiry(prisma: PrismaClient, id: string): Promise<void> {
  await waitFor(async () => {
    const [row, server] = await Promise.all([
      prisma.outboxEvent.findUnique({ where: { id }, select: { claimExpiresAt: true } }),
      prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`,
    ]);
    return row?.claimExpiresAt !== null &&
      row?.claimExpiresAt !== undefined &&
      server[0] !== undefined
      ? server[0].now >= row.claimExpiresAt
      : false;
  }, "outbox lease expiry");
}

async function waitForKafkaDeliveryDue(
  prisma: PrismaClient,
  consumerName: string,
  eventId: string,
): Promise<void> {
  await waitFor(async () => {
    const rows = await prisma.kafkaDelivery.findMany({
      where: { consumerName, eventId },
      select: { availableAt: true },
    });
    const row = rows[0];
    if (row === undefined) return false;
    return Date.now() >= row.availableAt.getTime();
  }, `Kafka delivery due for ${eventId}`);
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function repositoryId(prisma: PrismaClient, projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { githubRepositoryId: true },
  });
  if (project.githubRepositoryId === null)
    throw new Error("M8 fixture project has no repository identity");
  return project.githubRepositoryId.toString();
}

async function repositoryName(prisma: PrismaClient, projectId: string): Promise<string> {
  return (
    await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { repositoryFullName: true },
    })
  ).repositoryFullName;
}

async function installationId(prisma: PrismaClient, projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { installation: { select: { githubInstallationId: true } } },
  });
  return project.installation.githubInstallationId.toString();
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
