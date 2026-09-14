import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  DeploymentClaimRepository,
  OutboxRelayRepository,
  type PrismaClient,
} from "@previewforge/database";
import { type Admin, type Consumer, type EachMessagePayload, Kafka, type Producer } from "kafkajs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KAFKA_TOPICS, type WorkerConfig } from "./config.js";
import { type DeploymentConsumerOutcome, handleDeploymentMessage } from "./deployment-consumer.js";
import {
  consumerOptions,
  kafkaClientOptions,
  manualCommitRunOptions,
  producerOptions,
  producerSendOptions,
} from "./kafka/client.js";
import { ensureKafkaTopics } from "./kafka/topics.js";
import { relayOutboxBatch } from "./outbox-relay.js";

const databaseUrl = process.env.DATABASE_URL;
const kafkaBrokers = process.env.KAFKA_BROKERS?.split(",").map((value) => value.trim());
if (!databaseUrl) throw new Error("DATABASE_URL is required for worker integration tests");
if (!kafkaBrokers?.length || kafkaBrokers.some((value) => value.length === 0)) {
  throw new Error("KAFKA_BROKERS is required for worker integration tests");
}

const runId = randomUUID();
const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl,
  kafkaBrokers,
  kafkaClientId: `m3-integration-${runId}`,
  kafkaGroupId: `m3-integration-${runId}`,
  kafkaTopics: DEFAULT_KAFKA_TOPICS,
};

describe("M3 worker with real Kafka and PostgreSQL", () => {
  let prisma: PrismaClient;
  let producer: Producer;
  let admin: Admin;
  const consumers: Consumer[] = [];
  const groups: string[] = [];
  const fixtures: Fixture[] = [];

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

  afterAll(async () => {
    await Promise.allSettled(consumers.map((consumer) => consumer.disconnect()));
    await producer.disconnect();
    if (groups.length > 0) await admin.deleteGroups(groups).catch(() => undefined);
    await admin.disconnect();
    for (const fixture of fixtures) {
      await prisma.consumerReceipt.deleteMany({ where: { eventId: fixture.event.eventId } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: fixture.deploymentId } });
      await prisma.kafkaDelivery.deleteMany({ where: { eventId: fixture.event.eventId } });
      await prisma.user.deleteMany({ where: { id: fixture.userId } });
    }
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Keep scenarios isolated: every consumer group sees the shared topic, so
    // a live consumer from an earlier test could claim the next fixture first.
    await Promise.allSettled(consumers.splice(0).map((consumer) => consumer.disconnect()));
  });

  it("re-publishes an acknowledged event after mark crash and bounds it with durable attempts", async () => {
    const fixture = await createFixture(prisma, true);
    fixtures.push(fixture);
    const observed: string[] = [];
    const observer = await startConsumer(`m3-relay-observer-${runId}`, async ({ message }) => {
      if (message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
        observed.push(message.offset);
      }
    });
    consumers.push(observer);

    const repository = new OutboxRelayRepository(prisma);
    const markCrashRepository = {
      claimBatch: repository.claimBatch.bind(repository),
      recordFailure: repository.recordFailure.bind(repository),
      markPublished: async () => {
        throw new Error("injected after Kafka acknowledgement");
      },
    };

    const first = await relayOutboxBatch(markCrashRepository, producer, {
      owner: `relay-crash-${runId}`,
      leaseDurationMs: 40,
      maxAttempts: 3,
    });
    expect(first).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    await waitFor(() => observed.length >= 1, "first Kafka publish");
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: fixture.event.eventId } }),
    ).toMatchObject({
      attempts: 1,
      publishedAt: null,
    });

    await waitForOutboxLeaseExpiry(prisma, fixture.event.eventId);
    const restarted = await relayOutboxBatch(repository, producer, {
      owner: `relay-restarted-${runId}`,
      leaseDurationMs: 10_000,
      maxAttempts: 3,
    });
    expect(restarted).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    await waitFor(() => observed.length >= 2, "duplicate Kafka publish after restart");
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: fixture.event.eventId } }),
    ).toMatchObject({
      attempts: 2,
      publishedAt: expect.any(Date),
      claimToken: null,
    });
  }, 30_000);

  it("redelivers after DB commit before offset commit and keeps one receipt and transition", async () => {
    const fixture = await createFixture(prisma, false);
    fixtures.push(fixture);
    const groupId = `m3-consumer-restart-${runId}`;
    const claims = new DeploymentClaimRepository(prisma);
    const firstOutcome = deferred<DeploymentConsumerOutcome>();
    const first = await startConsumer(groupId, async (payload) => {
      const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
        repository: claims,
        consumerName: groupId,
        workerId: `worker-before-crash-${runId}`,
        offsets: kafkaOffsetCommitter(first),
        afterDatabaseCommitBeforeOffsetCommit: async () => {
          throw new Error("injected commit-before-offset crash");
        },
      });
      firstOutcome.resolve(outcome);
      if (!outcome.committed) throw new Error("stop at uncommitted message");
    });
    consumers.push(first);
    await publishEvent(fixture.event);

    await expect(withTimeout(firstOutcome.promise, "first consumer outcome")).resolves.toEqual({
      kind: "FAILED",
      committed: false,
      code: "OFFSET_COMMIT_DEFERRED",
    });
    await first.disconnect();
    expect(await receiptCount(prisma, groupId, fixture.event.eventId)).toBe(1);
    expect(await transitionCount(prisma, fixture.deploymentId, "CLONING")).toBe(1);

    const secondOutcome = deferred<DeploymentConsumerOutcome>();
    const second = await startConsumer(
      groupId,
      async (payload) => {
        const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: claims,
          consumerName: groupId,
          workerId: `worker-after-crash-${runId}`,
          offsets: kafkaOffsetCommitter(second),
        });
        secondOutcome.resolve(outcome);
      },
      false,
    );
    consumers.push(second);

    await expect(
      withTimeout(secondOutcome.promise, "restarted consumer outcome"),
    ).resolves.toMatchObject({
      kind: "ALREADY_PROCESSED",
      committed: true,
    });
    expect(await receiptCount(prisma, groupId, fixture.event.eventId)).toBe(1);
    expect(await transitionCount(prisma, fixture.deploymentId, "CLONING")).toBe(1);
  }, 40_000);

  it("dead-letters a key-mismatched poison message without persisting its raw secret", async () => {
    const fixture = await createFixture(prisma, false);
    fixtures.push(fixture);
    const groupId = `m3-poison-${runId}`;
    const outcome = deferred<DeploymentConsumerOutcome>();
    const consumer = await startConsumer(groupId, async (payload) => {
      outcome.resolve(
        await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: new DeploymentClaimRepository(prisma),
          consumerName: groupId,
          workerId: `worker-poison-${runId}`,
          offsets: kafkaOffsetCommitter(consumer),
        }),
      );
    });
    consumers.push(consumer);

    const poisoned = { ...fixture.event, ignoredSecret: "ghp_must-never-persist" };
    await producer.send(
      producerSendOptions(config.kafkaTopics.deploymentRequests, [
        {
          key: "wrong-environment",
          value: JSON.stringify(poisoned),
          headers: {
            "event-id": fixture.event.eventId,
            "event-type": fixture.event.eventType,
          },
        },
      ]),
    );

    await expect(withTimeout(outcome.promise, "poison outcome")).resolves.toEqual({
      kind: "DEAD_LETTERED",
      committed: true,
    });
    const delivery = await prisma.kafkaDelivery.findFirst({
      where: { consumerName: groupId, eventId: fixture.event.eventId },
    });
    expect(delivery).toMatchObject({
      status: "DEAD_LETTER",
      errorCode: "KEY_IDENTITY_MISMATCH",
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(delivery, bigintJson)).not.toContain("ghp_must-never-persist");
    expect(await receiptCount(prisma, groupId, fixture.event.eventId)).toBe(0);
    expect(await transitionCount(prisma, fixture.deploymentId, "CLONING")).toBe(0);
  }, 30_000);

  it("supersedes a stale desired SHA without acquiring a lease", async () => {
    const fixture = await createFixture(prisma, false);
    fixtures.push(fixture);
    await prisma.previewEnvironment.update({
      where: { id: fixture.environmentId },
      data: { desiredCommitSha: "f".repeat(40) },
    });
    const groupId = `m3-stale-${runId}`;
    const outcome = deferred<DeploymentConsumerOutcome>();
    const consumer = await startConsumer(groupId, async (payload) => {
      const result = await handleDeploymentMessage(toConsumerRecord(payload), {
        repository: new DeploymentClaimRepository(prisma),
        consumerName: groupId,
        workerId: `worker-stale-${runId}`,
        offsets: kafkaOffsetCommitter(consumer),
      });
      // A fresh Kafka group can briefly observe an older partition record while
      // its seeded end offsets settle. Only the fixture event is the oracle for
      // this test; unrelated records must not resolve the deferred assertion.
      if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
        outcome.resolve(result);
      }
    });
    consumers.push(consumer);
    await publishEvent(fixture.event);

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
    expect(await receiptCount(prisma, groupId, fixture.event.eventId)).toBe(1);
    expect(await transitionCount(prisma, fixture.deploymentId, "SUPERSEDED")).toBe(1);
  }, 30_000);

  it("runs the claimed build hook once and suppresses it after an offset redelivery", async () => {
    const fixture = await createFixture(prisma, false);
    fixtures.push(fixture);
    const groupId = `m4-hook-${runId}`;
    const claims = new DeploymentClaimRepository(prisma);
    let hookCalls = 0;
    const firstOutcome = deferred<DeploymentConsumerOutcome>();
    const first = await startConsumer(groupId, async (payload) => {
      const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
        repository: claims,
        consumerName: groupId,
        workerId: `worker-m4-hook-${runId}`,
        offsets: kafkaOffsetCommitter(first),
        afterClaim: async (event, claim) => {
          if (event.eventId !== fixture.event.eventId) return "PROCESSED";
          hookCalls += 1;
          void claim;
          return "PROCESSED";
        },
        afterDatabaseCommitBeforeOffsetCommit: async () => {
          throw new Error("injected M4 offset crash");
        },
      });
      if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
        firstOutcome.resolve(outcome);
        if (!outcome.committed) throw new Error("stop at uncommitted M4 message");
      }
    });
    consumers.push(first);
    await publishEvent(fixture.event);
    await expect(withTimeout(firstOutcome.promise, "M4 hook outcome")).resolves.toMatchObject({
      kind: "FAILED",
      committed: false,
      code: "OFFSET_COMMIT_DEFERRED",
    });
    await first.disconnect();

    const secondOutcome = deferred<DeploymentConsumerOutcome>();
    const second = await startConsumer(
      groupId,
      async (payload) => {
        const outcome = await handleDeploymentMessage(toConsumerRecord(payload), {
          repository: claims,
          consumerName: groupId,
          workerId: `worker-m4-hook-restarted-${runId}`,
          offsets: kafkaOffsetCommitter(second),
          afterClaim: async (event) => {
            if (event.eventId !== fixture.event.eventId) return "PROCESSED";
            hookCalls += 1;
            return "PROCESSED";
          },
        });
        if (payload.message.headers?.["event-id"]?.toString() === fixture.event.eventId) {
          secondOutcome.resolve(outcome);
        }
      },
      false,
    );
    consumers.push(second);
    await expect(withTimeout(secondOutcome.promise, "M4 hook redelivery")).resolves.toMatchObject({
      kind: "ALREADY_PROCESSED",
      committed: true,
    });
    expect(hookCalls).toBe(1);
    expect(await transitionCount(prisma, fixture.deploymentId, "CLONING")).toBe(1);
  }, 40_000);

  async function startConsumer(
    groupId: string,
    handler: (payload: EachMessagePayload) => Promise<void>,
    seedOffsets = true,
  ): Promise<Consumer> {
    if (seedOffsets)
      await seedGroupAtTopicEnd(admin, groupId, config.kafkaTopics.deploymentRequests);
    if (!groups.includes(groupId)) groups.push(groupId);
    const kafka = new Kafka(kafkaClientOptions({ ...config, kafkaGroupId: groupId }));
    const consumer = kafka.consumer(consumerOptions({ ...config, kafkaGroupId: groupId }));
    const joined = deferred<void>();
    consumer.on(consumer.events.GROUP_JOIN, () => joined.resolve());
    await consumer.connect();
    await consumer.subscribe({ topic: config.kafkaTopics.deploymentRequests });
    await consumer.run(manualCommitRunOptions(handler));
    await withTimeout(joined.promise, `consumer group join ${groupId}`, 15_000);
    return consumer;
  }

  async function publishEvent(event: DeploymentRequestedEvent): Promise<void> {
    await producer.send(
      producerSendOptions(config.kafkaTopics.deploymentRequests, [
        {
          key: event.environmentId,
          value: JSON.stringify(event),
          headers: { "event-id": event.eventId, "event-type": event.eventType },
        },
      ]),
    );
  }
});

type DeploymentRequestedEvent = {
  eventId: string;
  eventType: "deployment.requested.v1";
  occurredAt: string;
  deploymentId: string;
  environmentId: string;
  projectId: string;
  installationId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  commitSha: string;
};

type Fixture = {
  userId: string;
  environmentId: string;
  deploymentId: string;
  event: DeploymentRequestedEvent;
};

async function createFixture(prisma: PrismaClient, withOutbox: boolean): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const eventId = randomUUID();
  const commitSha = suffix.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
  const githubInstallationId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  const repositoryFullName = `m3-integration/${suffix}`;
  await prisma.user.create({
    data: { id: userId, githubUserId: `m3-${suffix}`, githubLogin: `m3-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(githubInstallationId),
      accountLogin: `m3-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: { id: projectId, installationId, ownerId: userId, repositoryFullName },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      previewKey: `m3-${suffix}`,
      desiredCommitSha: commitSha,
    },
  });
  await prisma.deployment.create({ data: { id: deploymentId, environmentId, commitSha } });
  const event: DeploymentRequestedEvent = {
    eventId,
    eventType: "deployment.requested.v1",
    occurredAt: new Date().toISOString(),
    deploymentId,
    environmentId,
    projectId,
    installationId: githubInstallationId,
    repositoryFullName,
    pullRequestNumber: 1,
    commitSha,
  };
  if (withOutbox) {
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
  return { userId, environmentId, deploymentId, event };
}

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

async function receiptCount(prisma: PrismaClient, consumerName: string, eventId: string) {
  return prisma.consumerReceipt.count({ where: { consumerName, eventId } });
}

async function transitionCount(prisma: PrismaClient, deploymentId: string, toStatus: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { aggregateId: deploymentId } });
  return rows.filter(
    (row) =>
      typeof row.payload === "object" &&
      row.payload !== null &&
      !Array.isArray(row.payload) &&
      row.payload.toStatus === toStatus,
  ).length;
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

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
