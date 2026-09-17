import { randomUUID } from "node:crypto";
import {
  type EnvironmentDeletionRequested,
  environmentDeletionRequestedSchema,
} from "@previewforge/contracts";
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
import { KubernetesReconciler } from "../kubernetes/reconciler.js";
import { isPreviewOwned, previewNamespace } from "../kubernetes/resource-renderer.js";
import {
  type EnvironmentDeletionConsumerOutcome,
  handleEnvironmentDeletionMessage,
} from "./environment-deletion-consumer.js";

const databaseUrl = process.env.DATABASE_URL;
const kafkaBrokers = process.env.KAFKA_BROKERS?.split(",").map((value) => value.trim());
if (!databaseUrl) throw new Error("DATABASE_URL is required for TTL acceptance");
if (!kafkaBrokers?.length || kafkaBrokers.some((value) => value.length === 0)) {
  throw new Error("KAFKA_BROKERS is required for TTL acceptance");
}

const runId = randomUUID();
const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl,
  kafkaBrokers,
  kafkaClientId: `m7-ttl-${runId}`,
  kafkaGroupId: `m7-ttl-${runId}`,
  kafkaTopics: {
    deploymentRequests: "previewforge.deployment-requests.v1",
    deploymentEvents: "previewforge.deployment-events.v1",
    environmentCommands: "previewforge.environment-commands.v1",
  },
};

describe("M7 TTL cleanup acceptance (PostgreSQL/Kafka/kind)", () => {
  let prisma: PrismaClient;
  let producer: Producer;
  let admin: Admin;
  const consumers: Consumer[] = [];
  const groups: string[] = [];
  const fixtures: Fixture[] = [];
  const kubernetes = createKubernetesResourceClient();
  const reconciler = new KubernetesReconciler(kubernetes);

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
    if (groups.length > 0) {
      await prisma.kafkaDelivery.deleteMany({ where: { consumerName: { in: groups } } });
    }
    for (const fixture of fixtures) {
      await removeNamespace(fixture.environmentId);
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: fixture.environmentId } });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await producer.disconnect();
    await admin.disconnect();
    await prisma.$disconnect();
  });

  it("creates one TTL intent, carries expiry metadata, and deletes through the Kafka coordinator", async () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    const expiresAt = new Date("2026-09-17T11:00:00.000Z");
    const fixture = await createFixture(prisma, expiresAt);
    fixtures.push(fixture);
    await applyNamespace(fixture, expiresAt);

    const repository = new EnvironmentDeletionRepository(prisma);
    await expect(repository.enqueueExpired({ now })).resolves.toMatchObject({ enqueued: 1 });
    const request = await prisma.environmentDeletionRequest.findUnique({
      where: { environmentId: fixture.environmentId },
      select: { reason: true, sourceUpdatedAt: true },
    });
    expect(request).toEqual({ reason: "ttl_expired", sourceUpdatedAt: expiresAt });
    const outbox = await prisma.outboxEvent.findFirst({
      where: { eventType: "environment.deletion-requested.v1", aggregateId: fixture.environmentId },
      orderBy: { createdAt: "desc" },
    });
    const event = environmentDeletionRequestedSchema.parse(outbox?.payload);
    expect(event.reason).toBe("ttl_expired");
    const namespace = await kubernetes.get(namespaceIdentity(fixture.environmentId));
    expect(namespace?.metadata.annotations?.["previewforge.dev/expires-at"]).toBe(
      expiresAt.toISOString(),
    );

    const outcome = await publishAndHandle(event);
    expect(outcome).toEqual({ kind: "PROCESSED", committed: true });
    await waitForAbsent(fixture.environmentId);
    expect(
      await prisma.environmentDeletionRequest.findUnique({
        where: { environmentId: fixture.environmentId },
      }),
    ).toMatchObject({ status: "COMPLETED", reason: "ttl_expired" });
    await expect(repository.enqueueExpired({ now })).resolves.toMatchObject({ enqueued: 0 });
  }, 60_000);

  it("leaves a future expiry active and does not create a deletion request", async () => {
    const fixture = await createFixture(prisma, new Date("2026-09-18T12:00:00.000Z"));
    fixtures.push(fixture);
    await applyNamespace(fixture, new Date("2026-09-18T12:00:00.000Z"));

    await new EnvironmentDeletionRepository(prisma).enqueueExpired({
      now: new Date("2026-09-17T12:00:00.000Z"),
    });
    expect(
      await prisma.environmentDeletionRequest.findUnique({
        where: { environmentId: fixture.environmentId },
      }),
    ).toBeNull();
    expect(await kubernetes.get(namespaceIdentity(fixture.environmentId))).not.toBeNull();
  }, 60_000);

  async function publishAndHandle(
    event: EnvironmentDeletionRequested,
  ): Promise<EnvironmentDeletionConsumerOutcome> {
    const groupId = `m7-ttl-consumer-${randomUUID()}`;
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
          deleteNamespace: (environmentId) => deletePreviewNamespace(environmentId),
          consumerName: groupId,
          offsets: { commitOffset: (offset) => consumer.commitOffsets([offset]) },
        },
      );
      if (payload.message.headers?.["event-id"]?.toString() === event.eventId) {
        observed.resolve(outcome);
      }
      if (!outcome.committed) throw new Error(`TTL acceptance did not commit: ${outcome.kind}`);
    });
    consumers.push(consumer);
    await producer.send(
      producerSendOptions(config.kafkaTopics.environmentCommands, [
        {
          key: event.environmentId,
          value: JSON.stringify(event),
          headers: { "event-id": event.eventId, "event-type": event.eventType },
        },
      ]),
    );
    return withTimeout(observed.promise, "TTL acceptance outcome", 30_000);
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
    await withTimeout(joined.promise, `TTL consumer group join ${groupId}`, 15_000);
    return consumer;
  }

  async function deletePreviewNamespace(environmentId: string): Promise<void> {
    const existing = await kubernetes.get(namespaceIdentity(environmentId));
    if (existing === null) return;
    if (!isPreviewOwned(existing, environmentId)) {
      throw Object.assign(new Error("Preview namespace ownership conflict"), {
        code: "PREVIEW_OWNERSHIP_CONFLICT",
        retryable: false,
      });
    }
    await reconciler.deletePreviewNamespace(environmentId);
  }

  async function applyNamespace(fixture: Fixture, expiresAt: Date): Promise<void> {
    await kubernetes.apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: previewNamespace(fixture.environmentId),
        labels: {
          "app.kubernetes.io/name": "preview",
          "app.kubernetes.io/managed-by": "previewforge",
          "previewforge.dev/managed": "true",
          "previewforge.dev/project-id": fixture.projectId,
          "previewforge.dev/environment-id": fixture.environmentId,
        },
        annotations: { "previewforge.dev/expires-at": expiresAt.toISOString() },
      },
    });
  }

  async function removeNamespace(environmentId: string): Promise<void> {
    const existing = await kubernetes.get(namespaceIdentity(environmentId)).catch(() => null);
    if (existing === null) return;
    await kubernetes.delete?.({
      ...namespaceIdentity(environmentId),
      ...(existing.metadata.uid === undefined ? {} : { uid: existing.metadata.uid }),
      ...(existing.metadata.resourceVersion === undefined
        ? {}
        : { resourceVersion: existing.metadata.resourceVersion }),
    });
  }
});

type Fixture = {
  userId: string;
  projectId: string;
  environmentId: string;
};

async function createFixture(prisma: PrismaClient, expiresAt: Date): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const pullRequestId = randomUUID();
  const environmentId = randomUUID();
  await prisma.user.create({
    data: { id: userId, githubUserId: `m7-ttl-${suffix}`, githubLogin: `m7-ttl-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1_000)}`),
      accountLogin: `m7-ttl-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      githubRepositoryId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1_000)}`),
      repositoryFullName: `m7-ttl/${suffix}`,
    },
  });
  await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number: 1,
      headSha: "a".repeat(40),
      state: "OPEN",
      sourceUpdatedAt: new Date("2026-09-17T10:00:00.000Z"),
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      pullRequestId,
      previewKey: `m7-ttl-${suffix}`,
      desiredCommitSha: "a".repeat(40),
      status: "ACTIVE",
      expiresAt,
    },
  });
  return { userId, projectId, environmentId };
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

async function waitForAbsent(environmentId: string): Promise<void> {
  const kubernetes = createKubernetesResourceClient();
  const identity = namespaceIdentity(environmentId);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await kubernetes.get(identity)) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`namespace ${identity.name} was not deleted before timeout`);
}
