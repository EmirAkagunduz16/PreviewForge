import {
  type Admin,
  type Consumer,
  type ConsumerRunConfig,
  type IHeaders,
  Kafka,
  type KafkaConfig,
  type Message,
  Partitioners,
  type Producer,
} from "kafkajs";
import type { WorkerConfig } from "../config.js";

export type KafkaClientBundle = {
  kafka: Kafka;
  producer: Producer;
  consumer: Consumer;
  feedbackConsumer: Consumer;
  cleanupConsumer: Consumer;
  admin: Admin;
};

export function kafkaClientOptions(config: WorkerConfig): KafkaConfig {
  return {
    clientId: config.kafkaClientId,
    brokers: [...config.kafkaBrokers],
  };
}

export function producerOptions(): NonNullable<Parameters<Kafka["producer"]>[0]> {
  return {
    createPartitioner: Partitioners.DefaultPartitioner,
    allowAutoTopicCreation: false,
    idempotent: false,
    maxInFlightRequests: 1,
    retry: { retries: 8 },
  };
}

export function consumerOptions(
  config: WorkerConfig,
  groupId = config.kafkaGroupId,
): Parameters<Kafka["consumer"]>[0] {
  return {
    groupId,
    allowAutoTopicCreation: false,
    retry: { retries: 8 },
  };
}

export function createKafkaClient(config: WorkerConfig): KafkaClientBundle {
  const kafka = new Kafka(kafkaClientOptions(config));
  return {
    kafka,
    producer: kafka.producer(producerOptions()),
    consumer: kafka.consumer(consumerOptions(config)),
    feedbackConsumer: kafka.consumer(
      consumerOptions(config, `${config.kafkaGroupId}:github-checks`),
    ),
    cleanupConsumer: kafka.consumer(
      consumerOptions(config, `${config.kafkaGroupId}:environment-cleanup`),
    ),
    admin: kafka.admin(),
  };
}

/** KafkaJS requires acknowledgements on the send request, not producer setup. */
export function producerSendOptions(
  topic: string,
  messages: readonly Message[],
): Parameters<Producer["send"]>[0] {
  return {
    acks: -1,
    topic,
    messages: [...messages],
  };
}

/**
 * `autoCommit: false` makes offset advancement an explicit post-transaction
 * action for the consumer. The handler must commit only after PostgreSQL has
 * durably recorded the receipt and state transition.
 */
export function manualCommitRunOptions(
  handler: NonNullable<ConsumerRunConfig["eachMessage"]>,
): ConsumerRunConfig {
  return {
    autoCommit: false,
    eachMessage: handler,
  };
}

export type { IHeaders };
