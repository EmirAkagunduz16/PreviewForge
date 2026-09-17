import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const fixtureRoot = join(repositoryRoot, "fixtures/m8");
const composeFile = join(repositoryRoot, "infrastructure/local/compose.yaml");
const defaultDatabaseUrl =
  "postgresql://previewforge:previewforge@127.0.0.1:55432/previewforge?schema=public";
const defaultKafkaBrokers = "127.0.0.1:59092";
const dockerContext =
  environment("PREVIEWFORGE_DOCKER_CONTEXT") ?? environment("DOCKER_CONTEXT") ?? "default";
const localPostgresPort = environment("M8_LOCAL_POSTGRES_PORT") ?? "55432";
const localKafkaPort = environment("M8_LOCAL_KAFKA_PORT") ?? "59092";
const runId = environment("M8_RUN_ID") ?? `${Date.now()}_${process.pid}`;
const sourceDatabaseName = databaseName(
  environment("M8_SOURCE_DATABASE_NAME") ?? `previewforge_m8_source_${runId}`,
  "previewforge_m8_source_",
);
const restoreDatabaseName = databaseName(
  environment("M8_RESTORE_DATABASE_NAME") ?? `previewforge_m8_restore_${runId}`,
  "previewforge_m8_restore_",
);
const dumpDirectory = await mkdtemp(join(tmpdir(), "previewforge-m8-drill-"));
const dumpPath = join(dumpDirectory, "m8-local-hardening.dump");
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
const baseDatabaseUrl = new URL(
  environment("M8_SOURCE_DATABASE_URL") ?? environment("DATABASE_URL") ?? defaultDatabaseUrl,
);
const kafkaBrokers = (
  environment("M8_KAFKA_BROKERS") ??
  environment("KAFKA_BROKERS") ??
  defaultKafkaBrokers
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ids = {
  userId: "a8000000-0000-4000-8000-000000000001",
  installationId: "a8000000-0000-4000-8000-000000000002",
  projectId: "a8000000-0000-4000-8000-000000000003",
};
const fixedAt = new Date("2026-09-17T08:00:00.000Z");
const sourceUrl = databaseUrlFor(baseDatabaseUrl, sourceDatabaseName);
const restoreUrl = databaseUrlFor(baseDatabaseUrl, restoreDatabaseName);
const adminUrl = databaseUrlFor(baseDatabaseUrl, "postgres");

let sourcePrisma;
let restorePrisma;
let kafkaBundle;
let observer;
let observerRun;
let observerGroup;
let checkpointBytes = 0;

const databaseModuleUrl = pathToFileURL(
  join(repositoryRoot, "packages/database/dist/index.js"),
).href;
const contractsModuleUrl = pathToFileURL(
  join(repositoryRoot, "packages/contracts/dist/index.js"),
).href;
const workerClientModuleUrl = pathToFileURL(
  join(repositoryRoot, "apps/worker/dist/kafka/client.js"),
).href;
const workerTopicsModuleUrl = pathToFileURL(
  join(repositoryRoot, "apps/worker/dist/kafka/topics.js"),
).href;
const workerRelayModuleUrl = pathToFileURL(
  join(repositoryRoot, "apps/worker/dist/outbox-relay.js"),
).href;

function environment(name) {
  return process.env[name];
}

function databaseName(value, prefix) {
  if (!new RegExp(`^${prefix}[a-z0-9_]+$`, "u").test(value) || value.length > 63) {
    throw new Error(`M8 database name must use the disposable ${prefix}<suffix> format`);
  }
  return value;
}

function databaseUrlFor(base, database) {
  const result = new URL(base);
  result.pathname = `/${database}`;
  result.searchParams.delete("schema");
  return result.toString();
}

function assertLocalTargets() {
  if (dockerContext !== "default") {
    throw new Error("M8 drill refuses a non-default Docker context");
  }
  if (environment("DOCKER_HOST")) {
    throw new Error("M8 drill refuses a DOCKER_HOST override");
  }
  const host = baseDatabaseUrl.hostname.toLowerCase();
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("M8 drill refuses a non-loopback PostgreSQL target");
  }
  if ((baseDatabaseUrl.port || "5432") !== localPostgresPort) {
    throw new Error(`M8 drill requires the local PostgreSQL port ${localPostgresPort}`);
  }
  if (kafkaBrokers.length === 0) throw new Error("M8 drill requires a Kafka broker");
  for (const broker of kafkaBrokers) {
    const match = broker.match(/^([^:]+):(\d+)$/u);
    if (!match || !new Set(["127.0.0.1", "localhost"]).has(match[1])) {
      throw new Error("M8 drill refuses a non-loopback Kafka target");
    }
    if (match[2] !== localKafkaPort) {
      throw new Error(`M8 drill requires the local Kafka port ${localKafkaPort}`);
    }
  }
}

function postgresContainerCommand(url, tool, args) {
  const parsed = new URL(url);
  const command = ["--context", dockerContext, "compose", "-f", composeFile, "exec", "-T"];
  const password = parsed.password === "" ? null : decodeURIComponent(parsed.password);
  if (password !== null) command.push("--env", `PGPASSWORD=${password}`);
  command.push(
    "postgres",
    tool,
    "--host=127.0.0.1",
    "--port=5432",
    `--username=${decodeURIComponent(parsed.username)}`,
    `--dbname=${decodeURIComponent(parsed.pathname.slice(1))}`,
    ...args,
  );
  return command;
}

function postgresEnvironment(url) {
  const parsed = new URL(url);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    ...(parsed.searchParams.get("sslmode") === null
      ? {}
      : { PGSSLMODE: parsed.searchParams.get("sslmode") }),
  };
}

async function runCommand(label, command, args, environment = process.env) {
  try {
    await execFileAsync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (cause) {
    throw commandError(label, cause);
  }
}

async function runCommandCapture(label, command, args, environment = process.env) {
  try {
    return await execFileAsync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    throw commandError(label, cause);
  }
}

async function runCommandWithInput(label, command, args, input, environment = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (cause) => reject(commandError(label, cause)));
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        commandError(label, {
          code: code ?? "unknown",
          stderr: Buffer.concat(stderr),
        }),
      );
    });
    child.stdin.end(input);
  });
}

function commandError(label, cause) {
  const code = cause?.code ?? "unknown";
  const stderr = Buffer.isBuffer(cause?.stderr)
    ? cause.stderr.toString("utf8").trim()
    : typeof cause?.stderr === "string"
      ? cause.stderr.trim()
      : "";
  return new Error(`${label} failed (${code})${stderr ? `: ${stderr}` : ""}`);
}

async function databaseExists(database) {
  try {
    const result = await execFileAsync(
      "psql",
      [
        "--no-psqlrc",
        "--no-password",
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT 1 FROM pg_database WHERE datname = '${database}';`,
      ],
      {
        cwd: repositoryRoot,
        env: postgresEnvironment(adminUrl),
        maxBuffer: 1_024 * 1_024,
      },
    );
    return result.stdout.trim() === "1";
  } catch (cause) {
    throw commandError(`check database ${database}`, cause);
  }
}

async function createDatabase(database) {
  if (await databaseExists(database))
    throw new Error(`refusing to reuse disposable database ${database}`);
  await runCommand(
    `create ${database}`,
    "createdb",
    ["--no-password", database],
    postgresEnvironment(adminUrl),
  );
}

async function dropDatabase(database) {
  if (!database) return;
  await runCommand(
    `drop ${database}`,
    "dropdb",
    ["--if-exists", "--no-password", database],
    postgresEnvironment(adminUrl),
  );
  if (await databaseExists(database)) {
    throw new Error(`M8 disposable database still exists after drop: ${database}`);
  }
}

async function migrateDatabase(url) {
  await runCommand(
    "apply current migrations",
    "pnpm",
    ["--filter", "@previewforge/database", "exec", "prisma", "migrate", "deploy"],
    { ...process.env, DATABASE_URL: url },
  );
}

async function buildRuntimePackages() {
  await runCommand("build contracts/database/worker packages", "pnpm", [
    "--filter",
    "@previewforge/worker...",
    "build",
  ]);
}

async function readWebhook(descriptorId) {
  const descriptor = manifest.github.webhookPayloads.find(({ id }) => id === descriptorId);
  if (!descriptor) throw new Error(`missing webhook fixture descriptor ${descriptorId}`);
  const raw = await readFile(join(fixtureRoot, descriptor.path));
  const payload = JSON.parse(raw);
  return { descriptor, raw, payload };
}

async function seedBase(prisma) {
  const createdAt = fixedAt;
  const user = await prisma.user.findUnique({ where: { id: ids.userId } });
  if (user === null) {
    await prisma.user.create({
      data: {
        id: ids.userId,
        githubUserId: "18000081",
        githubNumericId: 18000081n,
        githubLogin: "m8-fixtures-owner",
        createdAt,
        updatedAt: createdAt,
      },
    });
  } else {
    assertFields(
      user,
      {
        githubUserId: "18000081",
        githubNumericId: 18000081n,
        githubLogin: "m8-fixtures-owner",
      },
      "M8 fixture user",
    );
  }

  const installation = await prisma.installation.findUnique({ where: { id: ids.installationId } });
  if (installation === null) {
    await prisma.installation.create({
      data: {
        id: ids.installationId,
        githubInstallationId: 1800008n,
        githubAccountId: 18000081n,
        accountLogin: "m8-fixtures-owner",
        accountType: "User",
        ownerId: ids.userId,
        createdAt,
        updatedAt: createdAt,
      },
    });
  } else {
    assertFields(
      installation,
      {
        githubInstallationId: 1800008n,
        githubAccountId: 18000081n,
        accountLogin: "m8-fixtures-owner",
        accountType: "User",
        ownerId: ids.userId,
      },
      "M8 fixture installation",
    );
  }

  const project = await prisma.project.findUnique({ where: { id: ids.projectId } });
  if (project === null) {
    await prisma.project.create({
      data: {
        id: ids.projectId,
        installationId: ids.installationId,
        ownerId: ids.userId,
        githubRepositoryId: 2800008n,
        repositoryFullName: manifest.repository.repositoryFullName,
        defaultBranch: "main",
        dockerfilePath: "Dockerfile",
        containerPort: 8080,
        healthPath: "/health",
        createdAt,
        updatedAt: createdAt,
      },
    });
  } else {
    assertFields(
      project,
      {
        installationId: ids.installationId,
        ownerId: ids.userId,
        githubRepositoryId: 2800008n,
        repositoryFullName: manifest.repository.repositoryFullName,
        defaultBranch: "main",
        dockerfilePath: "Dockerfile",
        containerPort: 8080,
        healthPath: "/health",
      },
      "M8 fixture project",
    );
  }
}

async function seedWebhook(
  prisma,
  descriptorId,
  normalizePullRequestWebhookPayload,
  processWebhook,
) {
  const { descriptor, raw, payload } = await readWebhook(descriptorId);
  const event = normalizePullRequestWebhookPayload(payload);
  return processWebhook(prisma, {
    deliveryId: descriptor.deliveryId,
    eventName: "pull_request",
    payloadSha256: createHash("sha256").update(raw).digest("hex"),
    event,
    receivedAt: new Date(payload.pull_request.updated_at),
  });
}

async function seedFixture(
  prisma,
  normalizePullRequestWebhookPayload,
  processWebhook,
  { expectFresh },
) {
  await seedBase(prisma);
  const firstOpened = await seedWebhook(
    prisma,
    "opened",
    normalizePullRequestWebhookPayload,
    processWebhook,
  );
  const firstSynchronize = await seedWebhook(
    prisma,
    "synchronize",
    normalizePullRequestWebhookPayload,
    processWebhook,
  );
  if (expectFresh && (firstOpened.duplicate || firstSynchronize.duplicate)) {
    const deliveries = await prisma.webhookDelivery.findMany({
      select: { deliveryId: true, status: true },
      orderBy: { deliveryId: "asc" },
    });
    throw new Error(
      `first M8 seed unexpectedly deduplicated (opened=${firstOpened.duplicate}, synchronize=${firstSynchronize.duplicate}, rows=${JSON.stringify(deliveries)})`,
    );
  }
  if (!expectFresh && (!firstOpened.duplicate || !firstSynchronize.duplicate)) {
    throw new Error("repeated M8 seed did not deduplicate webhook delivery identities");
  }
  return readFixtureState(prisma);
}

async function readFixtureState(prisma) {
  const environment = await prisma.previewEnvironment.findFirst({
    where: { projectId: ids.projectId },
    select: { id: true, desiredCommitSha: true, status: true },
  });
  if (environment === null) throw new Error("M8 fixture environment was not created");
  const deployments = await prisma.deployment.findMany({
    where: { environmentId: environment.id },
    orderBy: { attempt: "asc" },
    select: { id: true, attempt: true, commitSha: true, status: true },
  });
  const outbox = await prisma.outboxEvent.findMany({
    where: { aggregateType: "deployment", aggregateId: { in: deployments.map(({ id }) => id) } },
    orderBy: { createdAt: "asc" },
    select: { id: true, aggregateId: true, eventType: true, publishedAt: true, payload: true },
  });
  const webhookDeliveries = await prisma.webhookDelivery.count({
    where: { installationId: ids.installationId },
  });
  const pullRequest = await prisma.pullRequest.findFirst({
    where: { projectId: ids.projectId, number: manifest.repository.pullRequestNumber },
    select: { state: true, headSha: true },
  });
  return {
    environmentId: environment.id,
    desiredCommitSha: environment.desiredCommitSha,
    environmentStatus: environment.status,
    pullRequestState: pullRequest?.state ?? null,
    pullRequestHeadSha: pullRequest?.headSha ?? null,
    deploymentIds: deployments.map(({ id }) => id),
    deploymentAttempts: deployments.map(({ attempt }) => attempt),
    deploymentCommits: deployments.map(({ commitSha }) => commitSha),
    deploymentStatuses: deployments.map(({ status }) => status),
    outboxIds: outbox.map(({ id }) => id),
    outboxEventTypes: outbox.map(({ eventType }) => eventType),
    pendingOutbox: outbox.filter(({ publishedAt }) => publishedAt === null).length,
    webhookDeliveries,
  };
}

function assertSeedState(state) {
  if (state.deploymentIds.length !== 2 || state.outboxIds.length !== 2) {
    throw new Error("M8 seed must produce exactly two deployment intents and two outbox rows");
  }
  if (state.deploymentAttempts.join(",") !== "1,2")
    throw new Error("M8 deployment attempts are not 1,2");
  if (
    state.deploymentCommits.join(",") !==
    `${manifest.commits.opened},${manifest.commits.synchronized}`
  ) {
    throw new Error("M8 deployment commits do not match the fixture manifest");
  }
  if (state.deploymentStatuses.some((status) => status !== "QUEUED")) {
    throw new Error("M8 seeded deployments must remain QUEUED before worker replay");
  }
  if (state.outboxEventTypes.some((eventType) => eventType !== "deployment.requested.v1")) {
    throw new Error("M8 seed produced a non-deployment outbox event");
  }
  if (state.pendingOutbox !== 2 || state.webhookDeliveries !== 2) {
    throw new Error("M8 seed state is not repeatable or pending as expected");
  }
  if (state.desiredCommitSha !== manifest.commits.synchronized) {
    throw new Error("M8 environment does not point at the synchronized commit");
  }
}

async function replayOutbox(prisma, state) {
  const [
    { createKafkaClient },
    { ensureKafkaTopics },
    { relayOutboxBatch },
    { OutboxRelayRepository },
  ] = await Promise.all([
    import(workerClientModuleUrl),
    import(workerTopicsModuleUrl),
    import(workerRelayModuleUrl),
    import(databaseModuleUrl),
  ]);
  const config = {
    nodeEnv: "test",
    databaseUrl: restoreUrl,
    kafkaBrokers,
    kafkaClientId: `m8-fixtures-relay-${runId}`,
    kafkaGroupId: `m8-fixtures-worker-${runId}`,
    kafkaTopics: {
      deploymentRequests: manifest.kafka.topics[0],
      deploymentEvents: manifest.kafka.topics[1],
      environmentCommands: manifest.kafka.topics[2],
    },
  };
  kafkaBundle = createKafkaClient(config);
  await kafkaBundle.admin.connect();
  await ensureKafkaTopics(kafkaBundle.admin, config);
  await kafkaBundle.producer.connect();

  observerGroup = `m8-fixtures-observer-${runId}`;
  observer = kafkaBundle.kafka.consumer({
    groupId: observerGroup,
    allowAutoTopicCreation: false,
    retry: { retries: 5 },
  });
  const observed = new Set();
  let observerFailure;
  let joinedResolve;
  const joined = new Promise((resolve) => {
    joinedResolve = resolve;
  });
  observer.on(observer.events.GROUP_JOIN, () => joinedResolve());
  await observer.connect();
  await observer.subscribe({ topic: config.kafkaTopics.deploymentRequests, fromBeginning: false });
  observerRun = observer
    .run({
      autoCommit: false,
      eachMessage: async ({ message }) => {
        const eventId = message.headers?.["event-id"]?.toString();
        if (eventId && state.outboxIds.includes(eventId)) observed.add(eventId);
      },
    })
    .catch((error) => {
      observerFailure = error;
    });
  await withTimeout(joined, "M8 Kafka observer group join", 15_000);

  const repository = new OutboxRelayRepository(prisma);
  const result = await relayOutboxBatch(repository, kafkaBundle.producer, {
    owner: `m8-fixtures-relay-${runId}`,
    retryBaseDelayMs: 50,
    retryMaxDelayMs: 100,
    random: () => 0,
  });
  await withTimeout(
    waitForSet(observed, new Set(state.outboxIds)),
    "M8 Kafka outbox replay",
    15_000,
  );
  if (observerFailure) throw observerFailure;
  if (result.claimed !== 2 || result.published !== 2 || result.failed !== 0) {
    throw new Error(
      `M8 outbox replay result was not exactly 2 published rows: ${JSON.stringify(result)}`,
    );
  }

  const replayed = await readFixtureState(prisma);
  if (replayed.pendingOutbox !== 0) throw new Error("M8 replay left a pending outbox row");
  return {
    ...result,
    observedEventIds: [...observed].sort(),
    consumerGroup: observerGroup,
  };
}

async function closeKafka() {
  if (observer) {
    await observer.disconnect().catch(() => undefined);
    observer = undefined;
  }
  if (observerRun) await observerRun.catch(() => undefined);
  let observerGroupDeleted = true;
  if (kafkaBundle?.admin && observerGroup) {
    const groupsBeforeDelete = await kafkaBundle.admin.listGroups();
    if (groupsBeforeDelete.groups.some(({ groupId }) => groupId === observerGroup)) {
      await kafkaBundle.admin.deleteGroups([observerGroup]);
      const groupsAfterDelete = await kafkaBundle.admin.listGroups();
      observerGroupDeleted = !groupsAfterDelete.groups.some(
        ({ groupId }) => groupId === observerGroup,
      );
      if (!observerGroupDeleted) throw new Error("M8 observer Kafka group was not deleted");
    }
  }
  if (kafkaBundle?.producer) await kafkaBundle.producer.disconnect().catch(() => undefined);
  if (kafkaBundle?.admin) await kafkaBundle.admin.disconnect().catch(() => undefined);
  kafkaBundle = undefined;
  observerGroup = undefined;
  return { observerGroupDeleted };
}

async function createCheckpoint() {
  const { stdout } = await runCommandCapture(
    "create PostgreSQL data-only checkpoint",
    "docker",
    postgresContainerCommand(sourceUrl, "pg_dump", [
      "--format=custom",
      "--data-only",
      "--no-owner",
      "--no-acl",
      "--exclude-table-data=_prisma_migrations",
    ]),
  );
  checkpointBytes = stdout.byteLength;
  if (checkpointBytes === 0) throw new Error("M8 PostgreSQL checkpoint is empty");
  await writeFile(dumpPath, stdout);
}

async function restoreCheckpoint() {
  await runCommandWithInput(
    "restore PostgreSQL data-only checkpoint",
    "docker",
    postgresContainerCommand(restoreUrl, "pg_restore", [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
    ]),
    await readFile(dumpPath),
  );
}

async function cleanupDatabases({ strict = true } = {}) {
  if (restorePrisma) {
    await restorePrisma.$disconnect().catch(() => undefined);
    restorePrisma = undefined;
  }
  if (sourcePrisma) {
    await sourcePrisma.$disconnect().catch(() => undefined);
    sourcePrisma = undefined;
  }
  const errors = [];
  const dropped = {
    sourceDatabaseDropped: false,
    restoreDatabaseDropped: false,
  };
  for (const [key, database] of [
    ["restoreDatabaseDropped", restoreDatabaseName],
    ["sourceDatabaseDropped", sourceDatabaseName],
  ]) {
    try {
      await dropDatabase(database);
      dropped[key] = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (strict && errors.length > 0) {
    throw new AggregateError(errors, "M8 disposable database cleanup failed");
  }
  return {
    ...dropped,
    errors: errors.map((error) => (error instanceof Error ? error.message : "unknown error")),
  };
}

async function main() {
  assertLocalTargets();
  await runCommand("validate M8 fixture manifest", process.execPath, [
    join(repositoryRoot, "scripts/m8/fixtures/manifest.mjs"),
    "--check",
  ]);
  await buildRuntimePackages();

  const [{ createPrismaClient }, { normalizePullRequestWebhookPayload }, { processWebhook }] =
    await Promise.all([
      import(databaseModuleUrl),
      import(contractsModuleUrl),
      import(databaseModuleUrl),
    ]);
  sourcePrisma = createPrismaClient(sourceUrl);
  await createDatabase(sourceDatabaseName);
  await migrateDatabase(sourceUrl);
  await sourcePrisma.$connect();
  const firstSeed = await seedFixture(
    sourcePrisma,
    normalizePullRequestWebhookPayload,
    processWebhook,
    { expectFresh: true },
  );
  assertSeedState(firstSeed);
  const secondSeed = await seedFixture(
    sourcePrisma,
    normalizePullRequestWebhookPayload,
    processWebhook,
    { expectFresh: false },
  );
  assertSeedState(secondSeed);
  await createCheckpoint();

  await createDatabase(restoreDatabaseName);
  await migrateDatabase(restoreUrl);
  await restoreCheckpoint();
  restorePrisma = createPrismaClient(restoreUrl);
  await restorePrisma.$connect();
  const restoredState = await readFixtureState(restorePrisma);
  assertSeedState(restoredState);
  if (
    JSON.stringify(restoredState.deploymentCommits) !== JSON.stringify(firstSeed.deploymentCommits)
  ) {
    throw new Error("restored deployment commit identities differ from the source checkpoint");
  }

  const { replay, kafkaCleanup } = await withQuietKafkaLogs(async () => {
    const replay = await replayOutbox(restorePrisma, restoredState);
    const kafkaCleanup = await closeKafka();
    return { replay, kafkaCleanup };
  });
  const databaseCleanup = await cleanupDatabases();
  await rm(dumpDirectory, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        fixtureId: manifest.fixtureId,
        sourceDatabase: sourceDatabaseName,
        restoreDatabase: restoreDatabaseName,
        seed: {
          firstDeploymentCount: firstSeed.deploymentIds.length,
          repeatedDeploymentCount: secondSeed.deploymentIds.length,
          repeatedWebhookDeliveryCount: secondSeed.webhookDeliveries,
        },
        restore: {
          checkpointBytes,
          deploymentCount: restoredState.deploymentIds.length,
          pendingOutboxBeforeReplay: restoredState.pendingOutbox,
          pendingOutboxAfterReplay: 0,
        },
        replay: {
          claimed: replay.claimed,
          published: replay.published,
          observedEventCount: replay.observedEventIds.length,
          observerGroupDeleted: kafkaCleanup.observerGroupDeleted,
        },
        cleanup: {
          ...databaseCleanup,
          dumpDirectoryRemoved: true,
          registryArtifactsCreated: false,
          kubernetesResourcesCreated: false,
        },
      },
      null,
      2,
    ),
  );
}

async function shutdownOnFailure() {
  await closeKafka().catch(() => undefined);
  await cleanupDatabases({ strict: false }).catch(() => undefined);
  await rm(dumpDirectory, { recursive: true, force: true }).catch(() => undefined);
}

async function withQuietKafkaLogs(operation) {
  const methods = ["debug", "info", "log", "warn"];
  const originals = new Map(methods.map((method) => [method, console[method]]));
  for (const method of methods) console[method] = () => {};
  try {
    return await operation();
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
}

try {
  await main();
} catch (error) {
  await shutdownOnFailure();
  console.error(error instanceof Error ? error.message : "M8 fixture drill failed");
  process.exitCode = 1;
}

function assertFields(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (typeof value === "bigint" ? actualValue !== value : actualValue !== value) {
      throw new Error(`${label} ownership mismatch at ${key}`);
    }
  }
}

function withTimeout(promise, label, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds).unref();
    }),
  ]);
}

async function waitForSet(actual, expected) {
  while (actual.size < expected.size) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
