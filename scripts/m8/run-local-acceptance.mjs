import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidenceDirectory = await mkdtemp(join(tmpdir(), "previewforge-m8-acceptance-"));
const composeScript = join(repositoryRoot, "scripts/local-infra.mjs");
const databaseUrl =
  process.env.M8_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://previewforge:previewforge@127.0.0.1:55432/previewforge?schema=public";
const kafkaBrokers = process.env.M8_KAFKA_BROKERS ?? process.env.KAFKA_BROKERS ?? "127.0.0.1:59092";
const apiPort = parsePort(process.env.M8_API_PORT ?? "4000", "M8_API_PORT");
const workerObservabilityPort = parsePort(
  process.env.M8_WORKER_OBSERVABILITY_PORT ?? "9465",
  "M8_WORKER_OBSERVABILITY_PORT",
);
const runId = process.env.M8_RUN_ID ?? `${Date.now()}_${process.pid}`;
const workerGroup = `m8-local-${runId}`.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 180);
const traceparent = "00-33333333333333333333333333333333-4444444444444444-01";
const probeEventId = "a8000000-0000-4000-8000-000000000099";
const probeEnvironmentId = "a8000000-0000-4000-8000-000000000098";
const probeDeploymentId = "a8000000-0000-4000-8000-000000000097";
const commands = [];
const services = [];
let observabilityProfileStarted = false;
let traceProbePublished = false;

function commandString(command, args) {
  return [command, ...args].join(" ");
}

async function run(label, command, args, environment = process.env) {
  const record = { label, command: commandString(command, args), status: "started" };
  commands.push(record);
  try {
    const result = await execFileAsync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    record.status = "passed";
    record.stdoutTail = tail(result.stdout);
    record.stderrTail = tail(result.stderr);
    return result;
  } catch (cause) {
    record.status = "failed";
    record.stdoutTail = tail(cause?.stdout);
    record.stderrTail = tail(cause?.stderr);
    throw new Error(
      `${label} failed: ${tail(cause?.stderr) || tail(cause?.stdout) || cause?.message}`,
    );
  }
}

function tail(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8").slice(-4_000);
  return typeof value === "string" ? value.slice(-4_000) : "";
}

function parsePort(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be numeric`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} is invalid`);
  return port;
}

function assertLoopbackDatabase() {
  const parsed = new URL(databaseUrl);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname)) {
    throw new Error("M8 acceptance refuses a non-loopback PostgreSQL target");
  }
  if ((parsed.port || "5432") !== "55432") {
    throw new Error("M8 acceptance requires local PostgreSQL port 55432");
  }
  const brokers = kafkaBrokers
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    brokers.length === 0 ||
    brokers.some((broker) => !/^((127\.0\.0\.1|localhost):59092)$/u.test(broker))
  ) {
    throw new Error("M8 acceptance requires loopback Kafka broker port 59092");
  }
}

async function assertRuntimeIdentity() {
  if (process.env.DOCKER_HOST) throw new Error("M8 acceptance refuses DOCKER_HOST overrides");
  const dockerContext = (
    await run("Docker context identity", "docker", ["context", "show"])
  ).stdout.trim();
  if (dockerContext !== "default")
    throw new Error(`M8 acceptance requires Docker context default, got ${dockerContext}`);
  const kubeContext = (
    await run("Kubernetes context identity", "kubectl", ["config", "current-context"])
  ).stdout.trim();
  if (!/^kind-/u.test(kubeContext))
    throw new Error(`M8 acceptance requires a disposable kind context, got ${kubeContext}`);
  await run("Kubernetes namespace identity", "kubectl", ["get", "namespace"]);
  return { dockerContext, kubeContext };
}

async function inspectRootlessBuildKit() {
  const socketPath =
    process.env.M8_BUILDKIT_SOCKET ?? "/var/tmp/previewforge-buildkit/buildkitd.sock";
  const binaries = {};
  for (const binary of ["buildkitd", "buildctl"]) {
    try {
      const result = await execFileAsync(binary, ["--version"], {
        cwd: repositoryRoot,
        env: process.env,
        maxBuffer: 1_024 * 1_024,
        encoding: "utf8",
      });
      binaries[binary] = tail(result.stdout || result.stderr);
    } catch {
      binaries[binary] = null;
    }
  }
  let socketAvailable = true;
  try {
    await access(socketPath);
  } catch {
    socketAvailable = false;
  }
  const available = Object.values(binaries).every(Boolean) && socketAvailable;
  commands.push({
    label: "rootless BuildKit prerequisite (informational)",
    command: `buildkitd --version + buildctl --version + socket ${socketPath}`,
    status: available ? "passed" : "open",
  });
  return { available, binaries, socketPath, socketAvailable };
}

function startService(label, command, args, environment) {
  const logPath = join(evidenceDirectory, `${label}.log`);
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: true,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  const append = (chunk) => {
    chunks.push(chunk.toString("utf8"));
    if (chunks.join("").length > 64_000) chunks.splice(0, chunks.length - 8);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code, signal) => {
    void writeFile(logPath, chunks.join(""));
    if (code !== null && code !== 0) {
      console.error(`${label} exited (${code}${signal ? `/${signal}` : ""}); log: ${logPath}`);
    }
  });
  services.push({ label, child, logPath });
  return child;
}

function signalService(service, signal) {
  if (service.child.pid === undefined) return;
  try {
    process.kill(-service.child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForJson(url, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reached";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      const parsed = JSON.parse(body);
      if (predicate(parsed)) return parsed;
      lastError = "oracle returned an unexpected body";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function waitForText(url, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reached";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (predicate(body)) return body;
      lastError = "oracle returned no expected sample";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function startLocalProcesses() {
  const common = {
    ...process.env,
    NODE_ENV: "test",
    PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT:
      process.env.PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT ?? "http://127.0.0.1:14318",
  };
  const apiEnvironment = {
    ...common,
    API_HOST: "0.0.0.0",
    API_PORT: String(apiPort),
    LOG_LEVEL: "error",
  };
  const workerEnvironment = {
    ...common,
    DATABASE_URL: databaseUrl,
    KAFKA_BROKERS: kafkaBrokers,
    KAFKA_CLIENT_ID: `m8-local-client-${runId}`.slice(0, 200),
    KAFKA_GROUP_ID: workerGroup,
    PREVIEWFORGE_WORKER_OBSERVABILITY_HOST: "0.0.0.0",
    PREVIEWFORGE_WORKER_OBSERVABILITY_PORT: String(workerObservabilityPort),
  };
  startService("api", "pnpm", ["--filter", "@previewforge/api", "start"], apiEnvironment);
  startService("worker", "pnpm", ["--filter", "@previewforge/worker", "start"], workerEnvironment);
  await waitForJson(
    `http://127.0.0.1:${apiPort}/health`,
    (body) => body.status === "ok",
    "API health",
  );
  await waitForJson(
    `http://127.0.0.1:${workerObservabilityPort}/health`,
    (body) => body.status === "ok",
    "worker health",
  );
  await waitForText(
    `http://127.0.0.1:${workerObservabilityPort}/metrics`,
    (body) => body.includes("previewforge_worker_health 1"),
    "worker Kafka consumer readiness",
  );
  return {
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    workerOrigin: `http://127.0.0.1:${workerObservabilityPort}`,
  };
}

async function publishTraceProbe() {
  const source = `
    import { Kafka } from "kafkajs";
    const kafka = new Kafka({ clientId: "m8-trace-probe", brokers: ${JSON.stringify(kafkaBrokers.split(",").map((value) => value.trim()))} });
    const producer = kafka.producer({ allowAutoTopicCreation: false, retry: { retries: 3 } });
    await producer.connect();
    await producer.send({ acks: -1, topic: "previewforge.deployment-requests.v1", messages: [{
      key: ${JSON.stringify(probeEnvironmentId)},
      value: JSON.stringify({ eventId: ${JSON.stringify(probeEventId)}, eventType: "deployment.requested.v1", occurredAt: "2026-09-17T00:00:00.000Z", deploymentId: ${JSON.stringify(probeDeploymentId)}, environmentId: ${JSON.stringify(probeEnvironmentId)}, projectId: "a8000000-0000-4000-8000-000000000096", installationId: "1800008", repositoryFullName: "previewforge/m8-probe", pullRequestNumber: 8, commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      headers: { "event-id": ${JSON.stringify(probeEventId)}, "event-type": "deployment.requested.v1", traceparent: ${JSON.stringify(traceparent)} }
    }]});
    await producer.disconnect();
  `;
  await run("Kafka trace propagation probe", "pnpm", [
    "--filter",
    "@previewforge/worker",
    "exec",
    "node",
    "--input-type=module",
    "-e",
    source,
  ]);
  traceProbePublished = true;
}

async function cleanupProbe() {
  await run("Kafka trace probe residue cleanup", "docker", [
    "--context",
    "default",
    "exec",
    "previewforge-postgres-1",
    "psql",
    "-U",
    "previewforge",
    "-d",
    "previewforge",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `DELETE FROM "kafka_deliveries" WHERE "event_id" = '${probeEventId}'; DELETE FROM "consumer_receipts" WHERE "event_id" = '${probeEventId}';`,
  ]);
}

async function inspectObservability(apiOrigin, workerOrigin) {
  const apiMetrics = await waitForText(
    `${apiOrigin}/metrics`,
    (body) => body.includes("previewforge_http_requests_total") && body.includes(" 1"),
    "API metrics",
  );
  await waitForText(
    `${workerOrigin}/metrics`,
    (body) => body.includes("previewforge_outbox_batches_total"),
    "worker runtime readiness",
  );
  await publishTraceProbe();
  const workerMetrics = await waitForText(
    `${workerOrigin}/metrics`,
    (body) =>
      body.includes("previewforge_worker_health 1") &&
      body.includes("previewforge_kafka_messages_total"),
    "worker metrics",
  );
  const apiTraces = await waitForJson(
    `${apiOrigin}/traces`,
    (body) => Array.isArray(body.spans) && body.spans.length > 0,
    "API traces",
  );
  const workerTraces = await waitForJson(
    `${workerOrigin}/traces`,
    (body) =>
      body.spans?.some(
        (span) => span.name === "kafka.consume" && span.traceId === traceparent.slice(3, 35),
      ),
    "worker Kafka traces",
  );
  if (
    JSON.stringify({ apiMetrics, workerMetrics, apiTraces, workerTraces }).match(
      /(?:gh[pors]_|github_pat_|bearer\s+|password\s*=)/iu,
    )
  ) {
    throw new Error("observability response contains credential-shaped data");
  }
  const dashboards = await waitForJson(
    "http://127.0.0.1:53000/api/search",
    (body) => Array.isArray(body) && body.some((item) => item.uid === "previewforge-m8-overview"),
    "Grafana dashboard provisioning",
    60_000,
  );
  const prometheus = await waitForJson(
    "http://127.0.0.1:59090/api/v1/query?query=previewforge_http_requests_total",
    (body) => body.status === "success" && body.data?.result?.length > 0,
    "Prometheus scrape sample",
    60_000,
  );
  const tempoReady = await waitForText(
    "http://127.0.0.1:53200/ready",
    (body) => body.trim() === "ready",
    "Tempo readiness",
    60_000,
  );
  return {
    apiMetricSamples: countMetricSamples(apiMetrics),
    workerMetricSamples: countMetricSamples(workerMetrics),
    apiTraceSpanCount: apiTraces.spans.length,
    workerTraceSpanCount: workerTraces.spans.length,
    dashboardCount: dashboards.length,
    prometheusSeries: prometheus.data.result.length,
    tempoReady: tempoReady.trim(),
  };
}

function countMetricSamples(body) {
  return body.split("\n").filter((line) => line.length > 0 && !line.startsWith("#")).length;
}

async function stopServices() {
  for (const service of services.reverse()) {
    if (service.child.exitCode !== null) continue;
    signalService(service, "SIGTERM");
  }
  await Promise.all(
    services.map(
      (service) =>
        new Promise((resolve) => {
          if (service.child.exitCode !== null) return resolve();
          const timer = setTimeout(() => {
            signalService(service, "SIGKILL");
            resolve();
          }, 10_000);
          service.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
}

async function stopObservabilityProfile() {
  if (!observabilityProfileStarted) return;
  await run("stop disposable observability profile", process.execPath, [
    composeScript,
    "--profile",
    "observability",
    "rm",
    "-sf",
    "prometheus",
    "tempo",
    "otel-collector",
    "grafana",
  ]);
  await run("remove disposable observability volumes", "docker", [
    "--context",
    "default",
    "volume",
    "rm",
    "previewforge_prometheus-data",
    "previewforge_tempo-data",
    "previewforge_grafana-data",
  ]).catch(() => undefined);
  observabilityProfileStarted = false;
}

async function main() {
  assertLoopbackDatabase();
  await run("validate M8 fixture manifest", process.execPath, [
    "scripts/m8/fixtures/manifest.mjs",
    "--check",
  ]);
  await run("start local PostgreSQL Kafka registry", process.execPath, [
    composeScript,
    "up",
    "-d",
    "--wait",
  ]);
  await run("start disposable observability profile", process.execPath, [
    composeScript,
    "--profile",
    "observability",
    "up",
    "-d",
    "--wait",
  ]);
  observabilityProfileStarted = true;
  const identity = await assertRuntimeIdentity();
  const buildKit = await inspectRootlessBuildKit();
  await run("build API and worker runtime", "pnpm", [
    "--filter",
    "@previewforge/worker...",
    "build",
  ]);
  await run("build API runtime", "pnpm", ["--filter", "@previewforge/api...", "build"]);
  const processes = await startLocalProcesses();
  const observability = await inspectObservability(processes.apiOrigin, processes.workerOrigin);
  await stopServices();
  if (traceProbePublished) await cleanupProbe();
  await run(
    "M8 API fault matrix",
    "pnpm",
    ["--filter", "@previewforge/api", "exec", "vitest", "run", "src/m8.integration.test.ts"],
    {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  );
  await run(
    "M8 worker fault matrix",
    "pnpm",
    [
      "--filter",
      "@previewforge/worker",
      "exec",
      "vitest",
      "run",
      "src/m8.acceptance.test.ts",
      "--no-file-parallelism",
    ],
    {
      ...process.env,
      DATABASE_URL: databaseUrl,
      KAFKA_BROKERS: kafkaBrokers,
    },
  );
  await run(
    "M8 PostgreSQL restore and outbox replay drill",
    process.execPath,
    ["scripts/m8/fixtures/drill.mjs"],
    {
      ...process.env,
      DATABASE_URL: databaseUrl,
      KAFKA_BROKERS: kafkaBrokers,
    },
  );
  if (
    !process.env.M5_IMAGE_REFERENCE ||
    !process.env.M5_IMAGE_DIGEST ||
    !process.env.M5_GATEWAY_URL
  ) {
    throw new Error(
      "M8 local acceptance requires M5_IMAGE_REFERENCE, M5_IMAGE_DIGEST, and M5_GATEWAY_URL for real kind/Envoy proof",
    );
  }
  await run("M5 real kind and Envoy acceptance", "pnpm", ["test:acceptance:m5"], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    KUBE_CONTEXT: identity.kubeContext,
  });
  await run("repository-wide check", "pnpm", ["check"], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    KAFKA_BROKERS: kafkaBrokers,
  });
  await run("diff whitespace check", "git", ["diff", "--check"]);
  console.log(
    JSON.stringify(
      {
        milestone: "M8",
        scope: "local-only",
        runtime: identity,
        buildKit,
        observability,
        commands: commands.map(({ label, command, status }) => ({ label, command, status })),
        evidenceDirectory,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  await stopServices().catch(() => undefined);
  if (traceProbePublished) await cleanupProbe().catch(() => undefined);
  await stopObservabilityProfile().catch(() => undefined);
  console.error(error instanceof Error ? error.message : "M8 local acceptance failed");
  console.error(JSON.stringify({ commands, evidenceDirectory }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(evidenceDirectory, { recursive: true, force: true }).catch(() => undefined);
}
