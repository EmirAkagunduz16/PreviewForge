import type { Admin, ITopicConfig } from "kafkajs";
import type { DEFAULT_KAFKA_TOPICS, WorkerConfig } from "../config.js";

export const KAFKA_TOPIC_PARTITIONS = 3;
export const KAFKA_TOPIC_REPLICATION_FACTOR = 1;

export type PreviewForgeTopic = keyof typeof DEFAULT_KAFKA_TOPICS;

export function topicNames(config: WorkerConfig): readonly string[] {
  return [
    config.kafkaTopics.deploymentRequests,
    config.kafkaTopics.deploymentEvents,
    config.kafkaTopics.environmentCommands,
  ];
}

export function topicConfig(config: WorkerConfig): readonly ITopicConfig[] {
  return topicNames(config).map((topic) => ({
    topic,
    numPartitions: KAFKA_TOPIC_PARTITIONS,
    replicationFactor: KAFKA_TOPIC_REPLICATION_FACTOR,
  }));
}

/**
 * Create all application topics explicitly. KafkaJS returns false when all
 * requested topics already exist; that is a successful idempotent outcome.
 */
export async function ensureKafkaTopics(admin: Admin, config: WorkerConfig): Promise<boolean> {
  const plannedTopics = topicConfig(config);
  const existingTopics = new Set(await admin.listTopics());
  const missingTopics = plannedTopics.filter(({ topic }) => !existingTopics.has(topic));

  if (missingTopics.length === 0) {
    return false;
  }

  return admin.createTopics({
    waitForLeaders: true,
    topics: missingTopics,
  });
}
