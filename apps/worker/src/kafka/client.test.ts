import { Partitioners } from "kafkajs";
import { describe, expect, it } from "vitest";
import { DEFAULT_KAFKA_TOPICS, type WorkerConfig } from "../config.js";
import {
  consumerOptions,
  kafkaClientOptions,
  manualCommitRunOptions,
  producerOptions,
  producerSendOptions,
} from "./client.js";

const config: WorkerConfig = {
  nodeEnv: "test",
  databaseUrl: "postgresql://localhost/previewforge",
  kafkaBrokers: ["localhost:59092"],
  kafkaClientId: "worker-test",
  kafkaGroupId: "worker-group-test",
  kafkaTopics: DEFAULT_KAFKA_TOPICS,
};

describe("Kafka client options", () => {
  it("uses the configured broker identity without exposing extra values", () => {
    expect(kafkaClientOptions(config)).toEqual({
      clientId: "worker-test",
      brokers: ["localhost:59092"],
    });
  });

  it("makes at-least-once producer posture explicit with bounded retries", () => {
    const options = producerOptions();
    expect(options).toMatchObject({
      allowAutoTopicCreation: false,
      idempotent: false,
      maxInFlightRequests: 1,
      retry: { retries: 8 },
    });
    expect(options.createPartitioner).toBe(Partitioners.DefaultPartitioner);
  });

  it("uses a stable consumer group and disables topic auto-creation", () => {
    expect(consumerOptions(config)).toEqual({
      groupId: "worker-group-test",
      allowAutoTopicCreation: false,
      retry: { retries: 8 },
    });
  });

  it("requests broker acknowledgement-all for each publish", () => {
    const options = producerSendOptions(DEFAULT_KAFKA_TOPICS.deploymentRequests, [
      { key: "environment-1", value: "{}" },
    ]);
    expect(options.acks).toBe(-1);
    expect(options.topic).toBe(DEFAULT_KAFKA_TOPICS.deploymentRequests);
    expect(options.messages).toEqual([{ key: "environment-1", value: "{}" }]);
  });

  it("requires explicit offset commit in the consumer run configuration", () => {
    const handler = async () => undefined;
    expect(manualCommitRunOptions(handler)).toEqual({ autoCommit: false, eachMessage: handler });
  });
});
