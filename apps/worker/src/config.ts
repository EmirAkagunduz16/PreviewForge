import { kafkaTopics } from "@previewforge/contracts";
import { decodeCredentialEncryptionKey } from "@previewforge/security";

export const DEFAULT_KAFKA_TOPICS = kafkaTopics;
export const DEFAULT_TTL_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 60_000;
const MAX_TTL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type NodeEnvironment = "development" | "test" | "production";

export type WorkerConfig = {
  nodeEnv: NodeEnvironment;
  databaseUrl: string;
  kafkaBrokers: readonly string[];
  kafkaClientId: string;
  kafkaGroupId: string;
  kafkaTopics: typeof DEFAULT_KAFKA_TOPICS;
  ttlSweepIntervalMs?: number;
  orphanSweepIntervalMs?: number;
  encryptionKey?: Buffer;
  build?: WorkerBuildConfig;
};

export type WorkerBuildConfig = {
  githubAppId: string;
  githubPrivateKey: string;
  githubApiBaseUrl: string;
  buildkitAddress: string;
  registryHost: string;
};

/**
 * Parse worker configuration without including secret-bearing values in an
 * error. A worker without a database and broker is not useful, so this parser
 * intentionally fails closed even in development and test environments.
 */
export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const nodeEnv = environment.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error(
      "Invalid worker configuration: NODE_ENV must be development, test, or production",
    );
  }

  const databaseUrl = requiredEnvironment(environment, "DATABASE_URL");
  if (!isPostgresUrl(databaseUrl)) {
    throw new Error(
      "Invalid worker configuration: DATABASE_URL must be a PostgreSQL connection URL",
    );
  }

  const kafkaBrokerValue = requiredEnvironment(environment, "KAFKA_BROKERS");
  const kafkaClientId = requiredName(environment, "KAFKA_CLIENT_ID");
  const kafkaGroupId = requiredName(environment, "KAFKA_GROUP_ID");
  const brokers = parseKafkaBrokers(kafkaBrokerValue);
  const build = parseBuildConfig(environment);
  const ttlSweepIntervalMs = parseTtlSweepInterval(environment);
  const orphanSweepIntervalMs = parseOrphanSweepInterval(environment);
  const encryptionKey = parseEncryptionKey(environment.ENCRYPTION_KEY);
  if (environment.PREVIEWFORGE_KUBERNETES_ENABLED === "true" && encryptionKey === undefined) {
    throw new Error(
      "Invalid worker configuration: ENCRYPTION_KEY is required when Kubernetes is enabled",
    );
  }

  return {
    nodeEnv,
    databaseUrl,
    kafkaBrokers: brokers,
    kafkaClientId,
    kafkaGroupId,
    kafkaTopics: DEFAULT_KAFKA_TOPICS,
    ttlSweepIntervalMs,
    orphanSweepIntervalMs,
    ...(encryptionKey === undefined ? {} : { encryptionKey }),
    ...(build === undefined ? {} : { build }),
  };
}

function parseTtlSweepInterval(environment: NodeJS.ProcessEnv): number {
  return parseSweepInterval(
    "PREVIEWFORGE_TTL_SWEEP_INTERVAL_MS",
    environment.PREVIEWFORGE_TTL_SWEEP_INTERVAL_MS,
    DEFAULT_TTL_SWEEP_INTERVAL_MS,
  );
}

function parseOrphanSweepInterval(environment: NodeJS.ProcessEnv): number {
  return parseSweepInterval(
    "PREVIEWFORGE_ORPHAN_SWEEP_INTERVAL_MS",
    environment.PREVIEWFORGE_ORPHAN_SWEEP_INTERVAL_MS,
    DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  );
}

function parseSweepInterval(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_TTL_SWEEP_INTERVAL_MS) {
    throw new Error(`Invalid worker configuration: ${name} is invalid`);
  }
  return parsed;
}

function parseEncryptionKey(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeCredentialEncryptionKey(value);
  } catch {
    throw new Error("Invalid worker configuration: ENCRYPTION_KEY must decode to 32 bytes");
  }
}

function parseBuildConfig(environment: NodeJS.ProcessEnv): WorkerBuildConfig | undefined {
  const names = [
    "GITHUB_APP_ID",
    "GITHUB_PRIVATE_KEY",
    "GITHUB_API_BASE_URL",
    "BUILDKIT_ADDR",
    "REGISTRY_HOST",
  ] as const;
  const present = names.filter((name) => (environment[name] ?? "").trim().length > 0);
  if (present.length === 0) return undefined;
  if (present.length !== names.length) {
    throw new Error("Invalid worker configuration: M4 build configuration is incomplete");
  }
  const githubAppId = requiredEnvironment(environment, "GITHUB_APP_ID");
  if (!/^[1-9][0-9]*$/.test(githubAppId)) {
    throw new Error("Invalid worker configuration: GITHUB_APP_ID is invalid");
  }
  const githubPrivateKey = requiredEnvironment(environment, "GITHUB_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );
  const githubApiBaseUrl = requiredOrigin(environment, "GITHUB_API_BASE_URL");
  const buildkitAddress = requiredEnvironment(environment, "BUILDKIT_ADDR");
  if (!buildkitAddress.startsWith("unix:///")) {
    throw new Error("Invalid worker configuration: BUILDKIT_ADDR is invalid");
  }
  const registryHost = requiredEnvironment(environment, "REGISTRY_HOST");
  if (!/^[A-Za-z0-9_.-]+(?::[0-9]+)?$/u.test(registryHost)) {
    throw new Error("Invalid worker configuration: REGISTRY_HOST is invalid");
  }
  return { githubAppId, githubPrivateKey, githubApiBaseUrl, buildkitAddress, registryHost };
}

function requiredOrigin(environment: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnvironment(environment, name);
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`Invalid worker configuration: ${name} is invalid`);
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Invalid worker configuration: ${name} is required`);
  }
  return value.trim();
}

function requiredName(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Invalid worker configuration: ${name} is required`);
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) {
    throw new Error(`Invalid worker configuration: ${name} contains invalid characters`);
  }
  return value;
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.pathname.slice(1).trim().length > 0
    );
  } catch {
    return false;
  }
}

function parseKafkaBrokers(value: string): readonly string[] {
  const brokers = value.split(",").map((broker) => broker.trim());

  if (brokers.length === 0 || brokers.some((broker) => broker.length === 0)) {
    throw new Error("Invalid worker configuration: KAFKA_BROKERS must contain a broker");
  }

  for (const broker of brokers) {
    if (!isKafkaBroker(broker)) {
      throw new Error("Invalid worker configuration: KAFKA_BROKERS contains an invalid broker");
    }
  }

  return brokers;
}

function isKafkaBroker(value: string): boolean {
  if (value.length > 255 || /\s|[\\/@?#]/.test(value) || value.includes("://")) {
    return false;
  }

  const ipv6Match = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    return ipv6Match[1] !== undefined && isValidPort(ipv6Match[2]);
  }

  const hostPort = value.match(/^([^:]+):(\d+)$/);
  if (!hostPort || hostPort[1] === undefined) {
    return false;
  }

  const host = hostPort[1];
  return host.length > 0 && host !== "." && host !== ".." && isValidPort(hostPort[2]);
}

function isValidPort(value: string | undefined): boolean {
  if (value === undefined) return false;
  const port = Number(value);
  return /^\d+$/.test(value) && Number.isInteger(port) && port >= 1 && port <= 65_535;
}
