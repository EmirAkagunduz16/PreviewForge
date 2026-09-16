import { describe, expect, it } from "vitest";
import { DEFAULT_KAFKA_TOPICS, loadWorkerConfig } from "./config.js";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://previewforge:secret@localhost:55432/previewforge",
  KAFKA_BROKERS: "localhost:59092,127.0.0.1:59093",
  KAFKA_CLIENT_ID: "previewforge-worker-test",
  KAFKA_GROUP_ID: "previewforge-worker-test-group",
};

describe("loadWorkerConfig", () => {
  it("requires the database and Kafka identity instead of starting partially configured", () => {
    expect(() => loadWorkerConfig({})).toThrow("DATABASE_URL is required");
    expect(() => loadWorkerConfig({ DATABASE_URL: validEnvironment.DATABASE_URL })).toThrow(
      "KAFKA_BROKERS is required",
    );
  });

  it("parses valid brokers and keeps the versioned topic contract", () => {
    expect(loadWorkerConfig(validEnvironment)).toEqual({
      nodeEnv: "test",
      databaseUrl: validEnvironment.DATABASE_URL,
      kafkaBrokers: ["localhost:59092", "127.0.0.1:59093"],
      kafkaClientId: "previewforge-worker-test",
      kafkaGroupId: "previewforge-worker-test-group",
      kafkaTopics: DEFAULT_KAFKA_TOPICS,
    });
  });

  it.each([
    "localhost",
    "http://localhost:59092",
    "localhost:0",
    "localhost:65536",
    "localhost:59092,",
    "user:password@localhost:59092",
    "localhost:59092/path",
  ])("rejects an unsafe broker value without echoing it: %s", (broker) => {
    expect(() => loadWorkerConfig({ ...validEnvironment, KAFKA_BROKERS: broker })).toThrow(
      "Invalid worker configuration",
    );
    expect(() => loadWorkerConfig({ ...validEnvironment, KAFKA_BROKERS: broker })).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(broker) }),
    );
  });

  it.each(["worker group", "worker/group", "worker$group", "\u0000worker", " worker", "worker "])(
    "rejects an unsafe Kafka identity without echoing it: %s",
    (identity) => {
      expect(() => loadWorkerConfig({ ...validEnvironment, KAFKA_CLIENT_ID: identity })).toThrow(
        "Invalid worker configuration",
      );
      expect(() => loadWorkerConfig({ ...validEnvironment, KAFKA_GROUP_ID: identity })).toThrow(
        "Invalid worker configuration",
      );
    },
  );

  it("supports bracketed IPv6 brokers", () => {
    expect(
      loadWorkerConfig({ ...validEnvironment, KAFKA_BROKERS: "[::1]:59092" }).kafkaBrokers,
    ).toEqual(["[::1]:59092"]);
  });

  it("accepts the shared encryption-key encodings and rejects invalid keys without echoing values", () => {
    expect(
      loadWorkerConfig({ ...validEnvironment, ENCRYPTION_KEY: "07".repeat(32) }).encryptionKey,
    ).toEqual(Buffer.alloc(32, 7));
    const secret = "not-a-valid-encryption-key";
    expect(() => loadWorkerConfig({ ...validEnvironment, ENCRYPTION_KEY: secret })).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secret) }),
    );
  });

  it("requires the shared key before enabling Kubernetes reconciliation", () => {
    expect(() =>
      loadWorkerConfig({ ...validEnvironment, PREVIEWFORGE_KUBERNETES_ENABLED: "true" }),
    ).toThrow("ENCRYPTION_KEY is required when Kubernetes is enabled");
    expect(
      loadWorkerConfig({
        ...validEnvironment,
        PREVIEWFORGE_KUBERNETES_ENABLED: "true",
        ENCRYPTION_KEY: "09".repeat(32),
      }).encryptionKey,
    ).toEqual(Buffer.alloc(32, 9));
  });

  it("parses the all-or-nothing M4 build configuration", () => {
    const configured = loadWorkerConfig({
      ...validEnvironment,
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
      GITHUB_API_BASE_URL: "https://api.github.com",
      BUILDKIT_ADDR: "unix:///var/tmp/previewforge-buildkit/buildkitd.sock",
      REGISTRY_HOST: "registry.local:5000",
    });
    expect(configured.build).toMatchObject({
      githubAppId: "123",
      githubApiBaseUrl: "https://api.github.com",
      buildkitAddress: "unix:///var/tmp/previewforge-buildkit/buildkitd.sock",
      registryHost: "registry.local:5000",
    });
    expect(configured.build?.githubPrivateKey).toContain("\n");
    expect(() => loadWorkerConfig({ ...validEnvironment, GITHUB_APP_ID: "123" })).toThrow(
      "M4 build configuration is incomplete",
    );
  });

  it("does not echo database credentials or client values in failures", () => {
    const secret = "database-password-that-must-not-echo";
    expect(() =>
      loadWorkerConfig({
        ...validEnvironment,
        DATABASE_URL: `not-postgres://${secret}`,
        KAFKA_CLIENT_ID: secret,
      }),
    ).toThrowError(expect.not.objectContaining({ message: expect.stringContaining(secret) }));
  });

  it.each(["postgresql:///previewforge", "postgresql://localhost/"])(
    "rejects a PostgreSQL URL without a host and database: %s",
    (databaseUrl) => {
      expect(() => loadWorkerConfig({ ...validEnvironment, DATABASE_URL: databaseUrl })).toThrow(
        "Invalid worker configuration",
      );
    },
  );
});
