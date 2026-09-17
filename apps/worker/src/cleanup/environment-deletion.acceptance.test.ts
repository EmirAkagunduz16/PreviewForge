import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  DeploymentFeedbackRepository,
  EnvironmentDeletionRepository,
  type PrismaClient,
} from "@previewforge/database";
import { type Admin, type Consumer, type EachMessagePayload, Kafka, type Producer } from "kafkajs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../config.js";
import {
  consumerOptions,
  kafkaClientOptions,
  manualCommitRunOptions,
  producerOptions,
  producerSendOptions,
} from "../kafka/client.js";
import { ensureKafkaTopics } from "../kafka/topics.js";
import { createKubernetesResourceClient } from "../kubernetes/client.js";
import {
  isPreviewOwned,
  type KubernetesResource,
  previewNamespace,
} from "../kubernetes/resource-renderer.js";
import {
  type EnvironmentDeletionConsumerOutcome,
  handleEnvironmentDeletionMessage,
} from "./environment-deletion-consumer.js";

const databaseUrl = process.env.DATABASE_URL;
const kafkaBrokers = process.env.KAFKA_BROKERS?.split(",").map((value) => value.trim());
if (!databaseUrl) throw new Error("DATABASE_URL is required for deletion acceptance");
if (!kafkaBrokers?.length || kafkaBrokers.some((value) => value.length === 0)) {
  throw new Error("KAFKA_BROKERS is required for deletion acceptance");
}

const runId = randomUUID();
const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl,
  kafkaBrokers,
  kafkaClientId: `m7-close-${runId}`,
  kafkaGroupId: `m7-close-${runId}`,
  kafkaTopics: {
    deploymentRequests: "previewforge.deployment-requests.v1",
    deploymentEvents: "previewforge.deployment-events.v1",
    environmentCommands: "previewforge.environment-commands.v1",
  },
};

describe("M7 pull-request-close cleanup acceptance", () => {
  let prisma: PrismaClient;
  let producer: Producer;
  let admin: Admin;
  const consumers: Consumer[] = [];
  const groups: string[] = [];
  const fixtures: Fixture[] = [];
  const kubernetes = createKubernetesResourceClient();

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    const kafka = new Kafka(kafkaClientOptions(config));
    producer = kafka.producer(producerOptions());
    admin = kafka.admin();
    await prisma.$connect();
    await admin.connect();
    await ensureKafkaTopics(admin, config);
    await producer.connect();
  });

  afterEach(async () => {
    await Promise.allSettled(consumers.splice(0).map((consumer) => consumer.disconnect()));
  });

  afterAll(async () => {
    await Promise.allSettled(consumers.splice(0).map((consumer) => consumer.disconnect()));
    if (groups.length > 0) await admin.deleteGroups(groups).catch(() => undefined);
    if (groups.length > 0)
      await prisma.kafkaDelivery.deleteMany({ where: { consumerName: { in: groups } } });
    for (const fixture of fixtures) {
      await removeNamespace(fixture.environmentId);
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await producer.disconnect();
    await admin.disconnect();
    await prisma.$disconnect();
  });

  it("consumes a close command from Kafka and deletes the owned kind namespace once", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await applyNamespace(fixture.environmentId, fixture.environmentId);
    const outcome = await publishAndHandle(fixture);

    expect(outcome).toEqual({ kind: "PROCESSED", committed: true });
    await waitFor(
      async () => (await kubernetes.get(namespaceIdentity(fixture.environmentId))) === null,
    );
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: fixture.requestId } }),
    ).toMatchObject({ status: "COMPLETED" });

    const duplicate = await publishAndHandle({
      ...fixture,
      event: { ...fixture.event, eventId: randomUUID() },
    });
    expect(duplicate).toEqual({ kind: "PROCESSED", committed: true });
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: fixture.requestId } }),
    ).toMatchObject({ status: "COMPLETED" });
  }, 60_000);

  it("dead-letters a wrong-owner close and leaves the kind namespace untouched", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await applyNamespace(fixture.environmentId, randomUUID());
    const outcome = await publishAndHandle(fixture);

    expect(outcome).toEqual({ kind: "DEAD_LETTERED", committed: true });
    expect(await kubernetes.get(namespaceIdentity(fixture.environmentId))).not.toBeNull();
    expect(
      await prisma.environmentDeletionRequest.findUnique({ where: { id: fixture.requestId } }),
    ).toMatchObject({ status: "FAILED", failureReason: "Preview namespace ownership conflict" });
  }, 60_000);

  async function publishAndHandle(fixture: Fixture): Promise<EnvironmentDeletionConsumerOutcome> {
    const groupId = `m7-close-consumer-${randomUUID()}`;
    groups.push(groupId);
    const observed = deferred<EnvironmentDeletionConsumerOutcome>();
    const consumer = await startConsumer(groupId, async (payload) => {
      const outcome = await handleEnvironmentDeletionMessage(
        {
          topic: payload.topic,
          partition: payload.partition,
          offset: payload.message.offset,
          key: payload.message.key,
          value: payload.message.value,
          ...(payload.message.headers === undefined ? {} : { headers: payload.message.headers }),
        },
        {
          repository: new EnvironmentDeletionRepository(prisma),
          deliveryRepository: new DeploymentFeedbackRepository(prisma),
          deleteNamespace: (environmentId) => kubernetesDeletePreviewNamespace(environmentId),
          consumerName: groupId,
          offsets: { commitOffset: (offset) => consumer.commitOffsets([offset]) },
        },
      );
      if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
        observed.resolve(outcome);
      }
      if (!outcome.committed)
        throw new Error(`deletion acceptance did not commit: ${outcome.kind}`);
    });
    consumers.push(consumer);
    await producer.send(
      producerSendOptions(config.kafkaTopics.environmentCommands, [
        {
          key: fixture.event.environmentId,
          value: JSON.stringify(fixture.event),
          headers: {
            "event-id": fixture.event.eventId,
            "event-type": fixture.event.eventType,
          },
        },
      ]),
    );
    return withTimeout(observed.promise, "deletion acceptance outcome", 30_000);
  }

  async function startConsumer(
    groupId: string,
    handler: (payload: EachMessagePayload) => Promise<void>,
  ): Promise<Consumer> {
    const kafka = new Kafka(kafkaClientOptions({ ...config, kafkaGroupId: groupId }));
    const consumer = kafka.consumer(consumerOptions({ ...config, kafkaGroupId: groupId }));
    const joined = deferred<void>();
    consumer.on(consumer.events.GROUP_JOIN, () => joined.resolve());
    await consumer.connect();
    await consumer.subscribe({
      topic: config.kafkaTopics.environmentCommands,
      fromBeginning: true,
    });
    await consumer.run(manualCommitRunOptions(handler));
    await withTimeout(joined.promise, `consumer group join ${groupId}`, 15_000);
    return consumer;
  }

  async function kubernetesDeletePreviewNamespace(environmentId: string): Promise<void> {
    const identity = namespaceIdentity(environmentId);
    const existing = await kubernetes.get(identity);
    if (existing !== null && !isPreviewOwned(existing, environmentId)) {
      throw Object.assign(new Error("Preview namespace ownership conflict"), {
        code: "PREVIEW_OWNERSHIP_CONFLICT",
        retryable: false,
      });
    }
    if (existing === null) return;
    const metadata = existing.metadata as KubernetesResource["metadata"] & {
      uid?: string;
      resourceVersion?: string;
    };
    if (metadata.uid === undefined || metadata.resourceVersion === undefined) {
      throw new Error("acceptance namespace is missing deletion preconditions");
    }
    await kubernetes.delete?.({
      ...identity,
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
    });
  }

  async function applyNamespace(environmentId: string, ownerEnvironmentId: string): Promise<void> {
    await kubernetes.apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: previewNamespace(environmentId),
        labels: {
          "app.kubernetes.io/managed-by": "previewforge",
          "previewforge.dev/managed": "true",
          "previewforge.dev/environment-id": ownerEnvironmentId,
        },
      },
    });
  }

  async function removeNamespace(environmentId: string): Promise<void> {
    const identity = namespaceIdentity(environmentId);
    const existing = await kubernetes.get(identity).catch(() => null);
    if (existing === null) return;
    const metadata = existing.metadata as KubernetesResource["metadata"] & {
      uid?: string;
      resourceVersion?: string;
    };
    if (metadata.uid === undefined || metadata.resourceVersion === undefined) return;
    await kubernetes.delete?.({
      ...identity,
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
    });
  }
});

type Fixture = {
  userId: string;
  environmentId: string;
  pullRequestId: string;
  requestId: string;
  event: {
    eventId: string;
    eventType: "environment.deletion-requested.v1";
    occurredAt: string;
    environmentId: string;
    sourceTimestamp: string;
    projectId: string;
    pullRequestId: string;
    pullRequestNumber: number;
    repositoryId: string;
    repositoryFullName: string;
    installationId: string;
    reason: "pull_request_closed";
  };
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const pullRequestId = randomUUID();
  const environmentId = randomUUID();
  const requestId = randomUUID();
  const repositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  const githubInstallationId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  const sourceTimestamp = "2026-09-17T12:00:00.000Z";
  const repositoryFullName = `m7-acceptance/${suffix}`;

  await prisma.user.create({
    data: { id: userId, githubUserId: `m7-${suffix}`, githubLogin: `m7-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(githubInstallationId),
      accountLogin: `m7-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      githubRepositoryId: BigInt(repositoryId),
      repositoryFullName,
    },
  });
  await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number: 1,
      headSha: "a".repeat(40),
      state: "CLOSED",
      sourceUpdatedAt: new Date(sourceTimestamp),
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      pullRequestId,
      previewKey: `m7-${suffix}`,
      desiredCommitSha: "a".repeat(40),
      status: "ACTIVE",
    },
  });
  await prisma.environmentDeletionRequest.create({
    data: {
      id: requestId,
      environmentId,
      requestKey: `environment:${environmentId}`,
      status: "REQUESTED",
      sourceUpdatedAt: new Date(sourceTimestamp),
      sourceDeliveryId: `m7-delivery-${suffix}`,
    },
  });

  return {
    userId,
    environmentId,
    pullRequestId,
    requestId,
    event: {
      eventId: randomUUID(),
      eventType: "environment.deletion-requested.v1",
      occurredAt: sourceTimestamp,
      environmentId,
      sourceTimestamp,
      projectId,
      pullRequestId,
      pullRequestNumber: 1,
      repositoryId,
      repositoryFullName,
      installationId: githubInstallationId,
      reason: "pull_request_closed",
    },
  };
}

function namespaceIdentity(environmentId: string) {
  return { apiVersion: "v1", kind: "Namespace", name: previewNamespace(environmentId) } as const;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, name: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("condition did not become true before timeout");
}
