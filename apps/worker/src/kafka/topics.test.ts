import { describe, expect, it } from "vitest";
import { DEFAULT_KAFKA_TOPICS, type WorkerConfig } from "../config.js";
import {
  ensureKafkaTopics,
  KAFKA_TOPIC_PARTITIONS,
  KAFKA_TOPIC_REPLICATION_FACTOR,
  topicConfig,
  topicNames,
} from "./topics.js";

const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl: "postgresql://localhost/previewforge",
  kafkaBrokers: ["localhost:59092"],
  kafkaClientId: "worker-test",
  kafkaGroupId: "worker-group-test",
  kafkaTopics: DEFAULT_KAFKA_TOPICS,
};

describe("Kafka topics", () => {
  it("keeps all M3 topics versioned and deterministic", () => {
    expect(topicNames(config)).toEqual([
      "previewforge.deployment-requests.v1",
      "previewforge.deployment-events.v1",
      "previewforge.environment-commands.v1",
    ]);
  });

  it("declares local-safe topic partition settings", () => {
    expect(topicConfig(config)).toEqual(
      topicNames(config).map((topic) => ({
        topic,
        numPartitions: KAFKA_TOPIC_PARTITIONS,
        replicationFactor: KAFKA_TOPIC_REPLICATION_FACTOR,
      })),
    );
  });

  it("is safe to call repeatedly when Kafka reports topics already exist", async () => {
    let listCalls = 0;
    let createCalls = 0;
    let receivedTopics: unknown;
    const admin = {
      listTopics: async () => {
        listCalls += 1;
        return [...topicNames(config)];
      },
      createTopics: async (options: unknown) => {
        createCalls += 1;
        receivedTopics = options;
        return false;
      },
    } as never;

    await expect(ensureKafkaTopics(admin, config)).resolves.toBe(false);
    expect(listCalls).toBe(1);
    expect(createCalls).toBe(0);
    expect(receivedTopics).toBeUndefined();
  });

  it("submits only missing topics to the broker", async () => {
    let receivedTopics: unknown;
    const existing = [config.kafkaTopics.deploymentRequests];
    const admin = {
      listTopics: async () => existing,
      createTopics: async (options: unknown) => {
        receivedTopics = options;
        return true;
      },
    } as never;

    await expect(ensureKafkaTopics(admin, config)).resolves.toBe(true);
    expect(receivedTopics).toEqual({
      waitForLeaders: true,
      topics: topicConfig(config).slice(1),
    });
  });

  it("creates all planned topics from a fresh broker", async () => {
    let receivedTopics: unknown;
    const admin = {
      listTopics: async () => [],
      createTopics: async (options: unknown) => {
        receivedTopics = options;
        return true;
      },
    } as never;

    await expect(ensureKafkaTopics(admin, config)).resolves.toBe(true);
    expect(receivedTopics).toEqual({
      waitForLeaders: true,
      topics: topicConfig(config),
    });
  });

  it("preserves Kafka's false result when another creator wins the race", async () => {
    const admin = {
      listTopics: async () => [],
      createTopics: async () => false,
    } as never;

    await expect(ensureKafkaTopics(admin, config)).resolves.toBe(false);
  });
});
