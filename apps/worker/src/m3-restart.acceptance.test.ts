import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPrismaClient, OutboxRelayRepository } from "@previewforge/database";
import { Kafka } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KAFKA_TOPICS, type WorkerConfig } from "./config.js";
import {
  consumerOptions,
  kafkaClientOptions,
  manualCommitRunOptions,
  producerOptions,
} from "./kafka/client.js";
import { relayOutboxBatch } from "./outbox-relay.js";

const databaseUrl = process.env.DATABASE_URL;
const kafkaBrokers = process.env.KAFKA_BROKERS?.split(",").map((value) => value.trim());
const kafkaContainer = process.env.M3_KAFKA_CONTAINER;
const dockerContext = process.env.PREVIEWFORGE_DOCKER_CONTEXT ?? "default";
if (!databaseUrl) throw new Error("DATABASE_URL is required for restart acceptance");
if (!kafkaBrokers?.length) throw new Error("KAFKA_BROKERS is required for restart acceptance");
if (!kafkaContainer) throw new Error("M3_KAFKA_CONTAINER is required for restart acceptance");
const kafkaContainerName = kafkaContainer;

const runId = randomUUID();
const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl,
  kafkaBrokers,
  kafkaClientId: `m3-restart-${runId}`,
  kafkaGroupId: `m3-restart-${runId}`,
  kafkaTopics: DEFAULT_KAFKA_TOPICS,
};

describe("M3 broker restart acceptance", () => {
  const prisma = createPrismaClient(databaseUrl);
  const eventId = randomUUID();
  const deploymentId = randomUUID();
  const environmentId = randomUUID();
  const event = {
    eventId,
    eventType: "deployment.requested.v1" as const,
    occurredAt: new Date().toISOString(),
    deploymentId,
    environmentId,
    projectId: randomUUID(),
    installationId: "42",
    repositoryFullName: "m3/restart-acceptance",
    pullRequestNumber: 1,
    commitSha: "a".repeat(40),
  };

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.outboxEvent.create({
      data: {
        id: eventId,
        eventType: event.eventType,
        aggregateType: "deployment",
        aggregateId: deploymentId,
        payload: event,
      },
    });
  });

  afterAll(async () => {
    startKafkaContainer();
    await prisma.outboxEvent.deleteMany({ where: { id: eventId } });
    await prisma.$disconnect();
  });

  it("keeps a pending intent in PostgreSQL while Kafka restarts and publishes after recovery", async () => {
    const repository = new OutboxRelayRepository(prisma);
    const unavailableKafka = new Kafka({
      ...kafkaClientOptions(config),
      connectionTimeout: 500,
      requestTimeout: 1_000,
      retry: { initialRetryTime: 100, retries: 1, maxRetryTime: 200 },
    });
    const unavailableProducer = unavailableKafka.producer({
      ...producerOptions(),
      retry: { initialRetryTime: 100, retries: 1, maxRetryTime: 200 },
    });
    await unavailableProducer.connect();

    stopKafkaContainer();
    const failed = await relayOutboxBatch(repository, unavailableProducer, {
      owner: `relay-during-restart-${runId}`,
      leaseDurationMs: 10_000,
      maxAttempts: 3,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 50,
      random: () => 0,
    });
    expect(failed).toMatchObject({
      claimed: 1,
      published: 0,
      retryableFailures: 1,
      deadLettered: 0,
    });
    expect(await prisma.outboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      attempts: 1,
      publishedAt: null,
      deadLetteredAt: null,
      claimToken: null,
    });
    await unavailableProducer.disconnect().catch(() => undefined);

    startKafkaContainer();
    await waitForKafka();
    await waitForOutboxAvailability();

    const recoveredKafka = new Kafka(kafkaClientOptions(config));
    const recoveredProducer = recoveredKafka.producer(producerOptions());
    const observerGroup = `m3-restart-observer-${runId}`;
    const admin = recoveredKafka.admin();
    await admin.connect();
    const endOffsets = await admin.fetchTopicOffsets(config.kafkaTopics.deploymentRequests);
    await admin.setOffsets({
      groupId: observerGroup,
      topic: config.kafkaTopics.deploymentRequests,
      partitions: endOffsets.map(({ partition, offset }) => ({ partition, offset })),
    });
    const observer = recoveredKafka.consumer(
      consumerOptions({ ...config, kafkaGroupId: observerGroup }),
    );
    const joined = deferred<void>();
    const observed = deferred<void>();
    observer.on(observer.events.GROUP_JOIN, () => joined.resolve());
    await observer.connect();
    await observer.subscribe({ topic: config.kafkaTopics.deploymentRequests });
    await observer.run(
      manualCommitRunOptions(async ({ message }) => {
        if (message.headers?.["event-id"]?.toString() === eventId) observed.resolve();
      }),
    );
    await withTimeout(joined.promise, "observer join", 15_000);
    await recoveredProducer.connect();

    const recovered = await relayOutboxBatch(repository, recoveredProducer, {
      owner: `relay-after-restart-${runId}`,
      leaseDurationMs: 10_000,
      maxAttempts: 3,
    });
    expect(recovered).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    await withTimeout(observed.promise, "recovered Kafka publish");
    expect(await prisma.outboxEvent.findUnique({ where: { id: eventId } })).toMatchObject({
      attempts: 2,
      publishedAt: expect.any(Date),
      deadLetteredAt: null,
    });

    await observer.disconnect();
    await recoveredProducer.disconnect();
    await admin.deleteGroups([observerGroup]).catch(() => undefined);
    await admin.disconnect();
  }, 60_000);

  function stopKafkaContainer(): void {
    execFileSync("docker", ["--context", dockerContext, "stop", kafkaContainerName], {
      stdio: "pipe",
      timeout: 20_000,
    });
  }

  function startKafkaContainer(): void {
    execFileSync("docker", ["--context", dockerContext, "start", kafkaContainerName], {
      stdio: "pipe",
      timeout: 20_000,
    });
  }

  async function waitForKafka(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const probe = new Kafka({
        ...kafkaClientOptions(config),
        connectionTimeout: 500,
        requestTimeout: 1_000,
        retry: { retries: 0 },
      }).admin();
      try {
        await probe.connect();
        await probe.fetchTopicMetadata({ topics: [config.kafkaTopics.deploymentRequests] });
        // Metadata can be served before the restarted broker has regained
        // leadership for every partition. Offset reads are the readiness
        // oracle used by the observer below, so require them to succeed too.
        await probe.fetchTopicOffsets(config.kafkaTopics.deploymentRequests);
        await probe.disconnect();
        return;
      } catch {
        await probe.disconnect().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("Kafka did not recover within the acceptance timeout");
  }

  async function waitForOutboxAvailability(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row, server] = await Promise.all([
        prisma.outboxEvent.findUnique({ where: { id: eventId }, select: { availableAt: true } }),
        prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`,
      ]);
      if (row && server[0] && server[0].now >= row.availableAt) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("outbox retry did not become available");
  }
});

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
