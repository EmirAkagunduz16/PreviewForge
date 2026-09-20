import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_STATE_DIRECTORY = "/var/tmp/previewforge-local";
export const OWNERSHIP_MARKER = "previewforge-local-runtime-v1";
export const DEFAULT_CLUSTER_NAME = "previewforge";
export const DEFAULT_GATEWAY_PORT = 18080;
export const DEFAULT_KIND_HTTP_HOST_PORT = 30080;
export const DEFAULT_KIND_HTTPS_HOST_PORT = 30443;
export const DEFAULT_POSTGRES_PORT = 55432;
export const DEFAULT_KAFKA_PORT = 59092;
export const DEFAULT_REGISTRY_PORT = 55000;
export const DEFAULT_API_PORT = 4000;
export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_WORKER_OBSERVABILITY_PORT = 9465;

const REQUIRED_COMMANDS = ["node", "pnpm", "docker", "kubectl", "kind"];
const LOCAL_INFRA_SERVICES = ["postgres", "kafka", "registry"];
const LOCAL_COMPOSE_FILE = join(REPOSITORY_ROOT, "infrastructure/local/compose.yaml");
const API_CONFIGURATION = [
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
  "PUBLIC_BASE_URL",
  "ENCRYPTION_KEY",
];
const WORKER_BUILD_CONFIGURATION = [
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_API_BASE_URL",
  "BUILDKIT_ADDR",
  "REGISTRY_HOST",
];

let shuttingDown = false;

export function parseDotEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const name = match[1];
    const rawValue = match[2] ?? "";
    values[name] = parseDotEnvValue(rawValue);
  }
  return values;
}

function parseDotEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.lastIndexOf('"');
    if (closingQuote > 0) {
      return trimmed
        .slice(1, closingQuote)
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\"/gu, '"')
        .replace(/\\\\/gu, "\\");
    }
  }
  if (trimmed.startsWith("'")) {
    const closingQuote = trimmed.lastIndexOf("'");
    if (closingQuote > 0) return trimmed.slice(1, closingQuote);
  }
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

export async function loadLocalEnvironment(
  envPath = join(REPOSITORY_ROOT, ".env"),
  base = process.env,
) {
  let fileValues = {};
  try {
    fileValues = parseDotEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...fileValues, ...base };
}

export function resolveStateDirectory(value = process.env.PREVIEWFORGE_LOCAL_STATE_DIR) {
  const candidate = resolve(value?.trim() || DEFAULT_STATE_DIRECTORY);
  const allowedRoots = ["/tmp", "/var/tmp"];
  const allowed = allowedRoots.some(
    (root) => candidate === root || candidate.startsWith(`${root}/`),
  );
  if (!allowed || candidate === "/" || candidate === REPOSITORY_ROOT) {
    throw new Error("PREVIEWFORGE_LOCAL_STATE_DIR must be an exact path below /tmp or /var/tmp");
  }
  const relativeToRoot = relative(REPOSITORY_ROOT, candidate);
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot))) {
    throw new Error("PREVIEWFORGE_LOCAL_STATE_DIR must not be inside the repository");
  }
  if (!/^previewforge-local(?:-[A-Za-z0-9._-]+)?$/u.test(candidate.split("/").at(-1) ?? "")) {
    throw new Error("PREVIEWFORGE_LOCAL_STATE_DIR must use a previewforge-local directory name");
  }
  return candidate;
}

function pathsForState(stateDirectory) {
  return {
    marker: join(stateDirectory, "OWNED-BY-PREVIEWFORGE"),
    state: join(stateDirectory, "state.json"),
    logs: join(stateDirectory, "logs"),
    kubeconfig: join(stateDirectory, "kubeconfig"),
  };
}

function commandExists(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runSync(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: options.env,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd: REPOSITORY_ROOT,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function composeArgs(environment, command, ...args) {
  return [
    "--context",
    contextFromEnvironment(environment),
    "compose",
    "-f",
    LOCAL_COMPOSE_FILE,
    command,
    ...args,
  ];
}

function inspectComposeContainers(environment, { all = true } = {}) {
  return Object.fromEntries(
    LOCAL_INFRA_SERVICES.map((service) => {
      try {
        const id = runSync("docker", composeArgs(environment, "ps", all ? "-aq" : "-q", service), {
          env: environment,
        }).trim();
        return [service, id];
      } catch (error) {
        throw new Error(`Cannot inspect local ${service} container: ${describeError(error)}`);
      }
    }),
  );
}

function newlyOwnedComposeServices(before, after) {
  return LOCAL_INFRA_SERVICES.filter((service) => !before[service] && after[service]);
}

async function stopOwnedComposeServices(environment, services) {
  if (!services?.length) return;
  await runStep(
    `stop owned local services (${services.join(", ")})`,
    "docker",
    composeArgs(environment, "stop", ...services),
    environment,
  );
  await runStep(
    `remove owned local service containers (${services.join(", ")})`,
    "docker",
    composeArgs(environment, "rm", "--force", ...services),
    environment,
  );
}

function requiredValue(environment, name) {
  return typeof environment[name] === "string" && environment[name].trim().length > 0;
}

function missingValues(environment, names) {
  return names.filter((name) => !requiredValue(environment, name));
}

function parsePort(environment, name, fallback) {
  const raw = environment[name] ?? String(fallback);
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be a numeric port`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} is outside 1..65535`);
  return port;
}

export function parseBuildkitAddress(value) {
  if (typeof value !== "string" || !value.startsWith("unix:///")) {
    throw new Error("BUILDKIT_ADDR must be an absolute unix:/// socket address");
  }
  const socketPath = value.slice("unix://".length);
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) {
    throw new Error("BUILDKIT_ADDR contains an invalid socket path");
  }
  if (socketPath.endsWith("/docker.sock")) {
    throw new Error("BUILDKIT_ADDR must not target a Docker socket");
  }
  return { address: value, socketPath };
}

export function parseRegistryHost(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+:[0-9]+$/u.test(value.trim())) {
    throw new Error("REGISTRY_HOST must be a host:port value");
  }
  const [host, rawPort] = value.trim().split(":");
  const port = Number(rawPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REGISTRY_HOST must use a valid host:port value");
  }
  return `${host}:${port}`;
}

function isLoopbackRegistryHost(value, port) {
  return value === `localhost:${port}` || value === `127.0.0.1:${port}`;
}

function resolveLocalRegistryHost(environment, port) {
  const explicit = environment.PREVIEWFORGE_REGISTRY_HOST?.trim();
  if (explicit) return parseRegistryHost(explicit);

  const configured = environment.REGISTRY_HOST?.trim();
  if (configured && !isLoopbackRegistryHost(configured, port)) {
    return parseRegistryHost(configured);
  }

  let gateway;
  try {
    gateway = runSync(
      "docker",
      ["network", "inspect", "kind", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
      { env: environment },
    ).trim();
  } catch (error) {
    throw new Error(
      `Cannot resolve the kind network gateway for the local registry: ${describeError(error)}`,
    );
  }
  if (!/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(gateway)) {
    throw new Error(`Kind network gateway is not an IPv4 address: ${gateway || "empty"}`);
  }
  return `${gateway}:${port}`;
}

export function parseManagedCommand(value) {
  if (!value) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PREVIEWFORGE_LOCAL_BUILDKIT_COMMAND must be a JSON string array");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("PREVIEWFORGE_LOCAL_BUILDKIT_COMMAND must be a non-empty JSON string array");
  }
  return parsed;
}

export function buildkitEnvironment(environment) {
  const names = [
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "BUILDKIT_ADDR",
    "BUILDKIT_SOCKET",
    "BUILDKIT_ROOT",
    "BUILDKIT_CONFIG",
    "REGISTRY_CONFIG",
    "PREVIEWFORGE_LOCAL_STATE_DIR",
  ];
  return Object.fromEntries(
    names
      .filter((name) => typeof environment[name] === "string")
      .map((name) => [name, environment[name]]),
  );
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertOwnership(stateDirectory) {
  const paths = pathsForState(stateDirectory);
  try {
    const directory = await lstat(stateDirectory);
    if (directory.isSymbolicLink()) throw new Error("state directory must not be a symlink");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`Refusing to use ${stateDirectory}: ${error.message}`);
  }
  try {
    const markerFile = await lstat(paths.marker);
    if (markerFile.isSymbolicLink()) throw new Error("ownership marker must not be a symlink");
    const marker = await readFile(paths.marker, "utf8");
    if (marker.trim() !== OWNERSHIP_MARKER) throw new Error("ownership marker does not match");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`Refusing to use ${stateDirectory}: ${error.message}`);
  }
  return true;
}

async function createOwnedState(stateDirectory) {
  const paths = pathsForState(stateDirectory);
  if (existsSync(stateDirectory) && !(await assertOwnership(stateDirectory))) {
    throw new Error(`Refusing to reuse unowned local state directory: ${stateDirectory}`);
  }
  try {
    const logsDirectory = await lstat(paths.logs);
    if (logsDirectory.isSymbolicLink())
      throw new Error("local logs directory must not be a symlink");
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new Error(`Refusing to use ${stateDirectory}: ${error.message}`);
  }
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  await writeFile(paths.marker, `${OWNERSHIP_MARKER}\n`, { mode: 0o600 });
  await chmod(stateDirectory, 0o700).catch(() => undefined);
  return paths;
}

async function readState(stateDirectory) {
  if (!(await assertOwnership(stateDirectory))) return undefined;
  const paths = pathsForState(stateDirectory);
  try {
    return JSON.parse(await readFile(paths.state, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read local runtime state: ${error.message}`);
  }
}

async function writeState(stateDirectory, state) {
  const paths = pathsForState(stateDirectory);
  try {
    const stateFile = await lstat(paths.state);
    if (stateFile.isSymbolicLink()) throw new Error("state file must not be a symlink");
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new Error(`Refusing to write local runtime state: ${error.message}`);
  }
  await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function removeOwnedState(stateDirectory) {
  if (!(await assertOwnership(stateDirectory))) return false;
  await rm(stateDirectory, { recursive: true, force: true });
  return true;
}

function describeError(error) {
  return error?.message || String(error);
}

async function waitForTcp(port, host = "127.0.0.1", timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not listening";
  while (Date.now() < deadline) {
    try {
      await new Promise((resolvePromise, reject) => {
        const socket = createConnection({ host, port });
        socket.once("connect", () => {
          socket.destroy();
          resolvePromise();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error?.message || "not listening";
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new Error(`port ${host}:${port} did not become ready: ${lastError}`);
}

async function waitForHttp(url, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (predicate(body)) return body;
      lastError = "unexpected response";
    } catch (error) {
      lastError = error?.message || "not reachable";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

function spawnTracked(name, command, args, environment, logPath) {
  const logHandle = openSync(logPath, "a", 0o600);
  const child = spawn(command, args, {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: environment,
    stdio: ["ignore", logHandle, logHandle],
  });
  child.once("error", (error) => {
    if (!shuttingDown) {
      console.error(`${name} could not start: ${describeError(error)}; see ${logPath}`);
    }
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(
        `${name} exited (${code ?? "signal"}${signal ? `/${signal}` : ""}); see ${logPath}`,
      );
    }
  });
  return { name, pid: child.pid, child, logPath };
}

function watchUnexpectedExit(service, cleanup) {
  service.child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
    console.error(`${service.name} exited unexpectedly (${reason}); see ${service.logPath}`);
    void cleanup(1).finally(() => process.exit(1));
  });
}

function signalProcessGroup(pid, signal = "SIGTERM") {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateTrackedChildren(state) {
  for (const child of [...(state.children ?? [])].reverse()) {
    if (child.managed === false) continue;
    signalProcessGroup(child.pid, "SIGTERM");
  }
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    (state.children ?? []).some((child) => child.managed !== false && isProcessAlive(child.pid))
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  for (const child of state.children ?? []) {
    if (child.managed !== false) signalProcessGroup(child.pid, "SIGKILL");
  }
}

function contextFromEnvironment(environment) {
  return environment.PREVIEWFORGE_DOCKER_CONTEXT || environment.DOCKER_CONTEXT || "default";
}

function clusterFromEnvironment(environment) {
  return environment.PREVIEWFORGE_KIND_CLUSTER || DEFAULT_CLUSTER_NAME;
}

export function environmentForState(environment, state) {
  const { COMPOSE_FILE: _composeFile, DOCKER_HOST: _dockerHost, ...safeEnvironment } = environment;
  const dockerContext =
    typeof state?.dockerContext === "string" && state.dockerContext.trim().length > 0
      ? state.dockerContext
      : contextFromEnvironment(environment);
  const clusterName =
    typeof state?.clusterName === "string" && state.clusterName.trim().length > 0
      ? state.clusterName
      : clusterFromEnvironment(environment);
  return {
    ...safeEnvironment,
    COMPOSE_PROJECT_NAME: "previewforge",
    PREVIEWFORGE_DOCKER_CONTEXT: dockerContext,
    DOCKER_CONTEXT: dockerContext,
    PREVIEWFORGE_KIND_CLUSTER: clusterName,
    ...(typeof state?.registryHost === "string" && state.registryHost.length > 0
      ? {
          PREVIEWFORGE_REGISTRY_HOST: state.registryHost,
          REGISTRY_HOST: state.registryHost,
          CONTAINER_REGISTRY: state.registryHost,
        }
      : {}),
    ...(typeof state?.kubeconfig === "string" && state.kubeconfig.length > 0
      ? { KUBECONFIG: state.kubeconfig }
      : {}),
    KUBE_CONTEXT: `kind-${clusterName}`,
  };
}

async function preflight(environment) {
  const missingCommands = REQUIRED_COMMANDS.filter((command) => !commandExists(command));
  if (missingCommands.length > 0)
    throw new Error(`Missing required commands: ${missingCommands.join(", ")}`);
  if (environment.DOCKER_HOST)
    throw new Error("DOCKER_HOST overrides are not supported by local runtime");
  if (environment.COMPOSE_PROJECT_NAME && environment.COMPOSE_PROJECT_NAME !== "previewforge") {
    throw new Error("COMPOSE_PROJECT_NAME must remain previewforge for local runtime ownership");
  }
  if (environment.COMPOSE_FILE) {
    throw new Error("COMPOSE_FILE overrides are not supported by local runtime");
  }

  const dockerContext = contextFromEnvironment(environment);
  try {
    runSync("docker", ["--context", dockerContext, "info"], { env: environment });
    runSync("docker", ["--context", dockerContext, "compose", "version"], { env: environment });
  } catch (error) {
    throw new Error(`Docker context ${dockerContext} is not ready: ${describeError(error)}`);
  }

  const missingApi = missingValues(environment, API_CONFIGURATION);
  if (missingApi.length > 0)
    throw new Error(`.env is missing API configuration: ${missingApi.join(", ")}`);
  const missingWorker = missingValues(environment, [
    "DATABASE_URL",
    "KAFKA_BROKERS",
    "KAFKA_CLIENT_ID",
    "KAFKA_GROUP_ID",
    ...WORKER_BUILD_CONFIGURATION,
  ]);
  if (missingWorker.length > 0)
    throw new Error(`.env is missing worker configuration: ${missingWorker.join(", ")}`);
  if (environment.PREVIEWFORGE_KUBERNETES_ENABLED !== "true") {
    throw new Error("PREVIEWFORGE_KUBERNETES_ENABLED must be true for local runtime");
  }

  const buildkit = parseBuildkitAddress(environment.BUILDKIT_ADDR);
  if (!commandExists("buildctl")) {
    throw new Error("buildctl is required to verify the rootless BuildKit boundary");
  }
  const managedBuildkitCommand = parseManagedCommand(
    environment.PREVIEWFORGE_LOCAL_BUILDKIT_COMMAND,
  );
  if (!managedBuildkitCommand && (!commandExists("buildctl") || !existsSync(buildkit.socketPath))) {
    throw new Error(
      `Rootless BuildKit is not ready at ${buildkit.socketPath}; install/provision the accepted M4 runtime or set PREVIEWFORGE_LOCAL_BUILDKIT_COMMAND to a safe JSON command that owns this socket`,
    );
  }
  if (!managedBuildkitCommand) {
    try {
      runSync("buildctl", ["--addr", buildkit.address, "debug", "workers"], {
        env: buildkitEnvironment(environment),
      });
    } catch (error) {
      throw new Error(`Rootless BuildKit socket is not usable: ${describeError(error)}`);
    }
  }

  const apiPort = parsePort(environment, "API_PORT", DEFAULT_API_PORT);
  const webPort = parsePort(environment, "WEB_PORT", DEFAULT_WEB_PORT);
  const workerPort = parsePort(
    environment,
    "PREVIEWFORGE_WORKER_OBSERVABILITY_PORT",
    DEFAULT_WORKER_OBSERVABILITY_PORT,
  );
  const gatewayPort = parsePort(
    environment,
    "PREVIEWFORGE_GATEWAY_LOCAL_PORT",
    DEFAULT_GATEWAY_PORT,
  );
  const kindHttpHostPort = parsePort(
    environment,
    "PREVIEWFORGE_KIND_HTTP_HOST_PORT",
    DEFAULT_KIND_HTTP_HOST_PORT,
  );
  const kindHttpsHostPort = parsePort(
    environment,
    "PREVIEWFORGE_KIND_HTTPS_HOST_PORT",
    DEFAULT_KIND_HTTPS_HOST_PORT,
  );
  const registryPort = parsePort(
    environment,
    "PREVIEWFORGE_REGISTRY_LOCAL_PORT",
    DEFAULT_REGISTRY_PORT,
  );
  const postgresPort = parsePort(
    environment,
    "PREVIEWFORGE_POSTGRES_LOCAL_PORT",
    DEFAULT_POSTGRES_PORT,
  );
  const kafkaPort = parsePort(environment, "PREVIEWFORGE_KAFKA_LOCAL_PORT", DEFAULT_KAFKA_PORT);
  return {
    dockerContext,
    clusterName: clusterFromEnvironment(environment),
    apiPort,
    webPort,
    workerPort,
    gatewayPort,
    kindHttpHostPort,
    kindHttpsHostPort,
    registryPort,
    postgresPort,
    kafkaPort,
    buildkit,
    managedBuildkitCommand,
  };
}

async function writeKubeconfig(stateDirectory, environment, clusterName) {
  const paths = pathsForState(stateDirectory);
  try {
    const kubeconfig = await lstat(paths.kubeconfig);
    if (kubeconfig.isSymbolicLink()) throw new Error("kubeconfig must not be a symlink");
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new Error(`Refusing to write local kubeconfig: ${error.message}`);
  }
  const { stdout } = await run("kind", ["get", "kubeconfig", "--name", clusterName], {
    env: environment,
  });
  await writeFile(paths.kubeconfig, stdout, { mode: 0o600 });
  await chmod(paths.kubeconfig, 0o600);
  return paths.kubeconfig;
}

async function runStep(label, command, args, environment) {
  process.stdout.write(`[local] ${label}\n`);
  try {
    await run(command, args, { env: environment });
  } catch (error) {
    throw new Error(`${label} failed: ${describeError(error)}`);
  }
}

async function startManagedBuildkit(environment, buildkit, command, children, paths) {
  if (!command) return undefined;
  const [executable, ...args] = command;
  const safeEnvironment = buildkitEnvironment(environment);
  const child = spawnTracked(
    "buildkit",
    executable,
    args,
    safeEnvironment,
    join(paths.logs, "buildkit.log"),
  );
  children.push({ name: child.name, pid: child.pid, managed: true, logPath: child.logPath });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child.pid))
      throw new Error(`managed BuildKit exited; see ${child.logPath}`);
    if (existsSync(buildkit.socketPath)) {
      try {
        runSync("buildctl", ["--addr", buildkit.address, "debug", "workers"], {
          env: safeEnvironment,
        });
        return child;
      } catch {
        // The socket may exist before BuildKit has finished initializing.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`managed BuildKit did not expose ${buildkit.socketPath}; see ${child.logPath}`);
}

async function up() {
  const environment = await loadLocalEnvironment();
  const stateDirectory = resolveStateDirectory(environment.PREVIEWFORGE_LOCAL_STATE_DIR);
  const existingState = await readState(stateDirectory);
  if (existingState && isProcessAlive(existingState.supervisorPid)) {
    console.log(
      `PreviewForge local runtime is already running (pid ${existingState.supervisorPid})`,
    );
    await status({ environment, stateDirectory, state: existingState });
    return;
  }
  if (existingState)
    throw new Error(
      `Stale local runtime state exists at ${stateDirectory}; run pnpm local:down first`,
    );

  const plan = await preflight(environment);
  const paths = await createOwnedState(stateDirectory);
  const state = {
    version: 1,
    supervisorPid: process.pid,
    stateDirectory,
    dockerContext: plan.dockerContext,
    clusterName: plan.clusterName,
    clusterCreated: false,
    buildkitAddress: plan.buildkit.address,
    ownedComposeServices: [],
    kubeconfig: paths.kubeconfig,
    ports: {
      api: plan.apiPort,
      web: plan.webPort,
      worker: plan.workerPort,
      gateway: plan.gatewayPort,
      registry: plan.registryPort,
      postgres: plan.postgresPort,
      kafka: plan.kafkaPort,
    },
    children: [],
    startedAt: new Date().toISOString(),
  };
  await writeState(stateDirectory, state);
  const childEnvironment = {
    ...environment,
    PREVIEWFORGE_DOCKER_CONTEXT: plan.dockerContext,
    DOCKER_CONTEXT: plan.dockerContext,
    PREVIEWFORGE_KIND_CLUSTER: plan.clusterName,
    PREVIEWFORGE_GATEWAY_LOCAL_PORT: String(plan.gatewayPort),
    PREVIEWFORGE_KIND_HTTP_HOST_PORT: String(plan.kindHttpHostPort),
    PREVIEWFORGE_KIND_HTTPS_HOST_PORT: String(plan.kindHttpsHostPort),
    PREVIEWFORGE_ENVOY_GATEWAY_WAIT_SECONDS:
      environment.PREVIEWFORGE_ENVOY_GATEWAY_WAIT_SECONDS ?? "300",
    PREVIEWFORGE_REGISTRY_LOCAL_PORT: String(plan.registryPort),
    PREVIEWFORGE_POSTGRES_LOCAL_PORT: String(plan.postgresPort),
    PREVIEWFORGE_KAFKA_LOCAL_PORT: String(plan.kafkaPort),
    PREVIEWFORGE_WORKER_OBSERVABILITY_PORT: String(plan.workerPort),
    KUBECONFIG: paths.kubeconfig,
    KUBE_CONTEXT: `kind-${plan.clusterName}`,
    API_PORT: String(plan.apiPort),
    WEB_PORT: String(plan.webPort),
  };

  let cleanupPromise;
  const cleanup = (exitCode = 0) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      shuttingDown = true;
      await terminateTrackedChildren(state).catch((error) =>
        console.error(`[local] child cleanup: ${describeError(error)}`),
      );
      await stopOwnedComposeServices(childEnvironment, state.ownedComposeServices).catch((error) =>
        console.error(`[local] ${error.message}`),
      );
      if (state.clusterCreated) {
        await runStep(
          "delete owned kind cluster",
          "kind",
          ["delete", "cluster", "--name", state.clusterName],
          childEnvironment,
        ).catch((error) => console.error(`[local] ${error.message}`));
      }
      await removeOwnedState(stateDirectory).catch((error) =>
        console.error(`[local] state cleanup: ${describeError(error)}`),
      );
      if (exitCode !== undefined) process.exitCode = exitCode;
    })();
    return cleanupPromise;
  };
  process.once("SIGINT", () => void cleanup(0).finally(() => process.exit(0)));
  process.once("SIGTERM", () => void cleanup(0).finally(() => process.exit(0)));

  try {
    const managedBuildkit = await startManagedBuildkit(
      childEnvironment,
      plan.buildkit,
      plan.managedBuildkitCommand,
      state.children,
      paths,
    );
    if (managedBuildkit) watchUnexpectedExit(managedBuildkit, cleanup);
    await writeState(stateDirectory, state);
    const composeBefore = inspectComposeContainers(childEnvironment);
    try {
      await runStep(
        "start local PostgreSQL Kafka registry",
        process.execPath,
        ["scripts/local-infra.mjs", "up", "-d", "--wait"],
        childEnvironment,
      );
    } finally {
      const composeAfter = inspectComposeContainers(childEnvironment);
      state.ownedComposeServices = newlyOwnedComposeServices(composeBefore, composeAfter);
      await writeState(stateDirectory, state);
    }
    await runStep(
      "apply database migrations",
      "pnpm",
      ["--filter", "@previewforge/database", "exec", "prisma", "migrate", "deploy"],
      childEnvironment,
    );
    const clusterList = runSync("kind", ["get", "clusters"], { env: childEnvironment });
    state.clusterCreated = !clusterList
      .split(/\r?\n/u)
      .some((value) => value.trim() === state.clusterName);
    await writeState(stateDirectory, state);
    await runStep(
      "bootstrap kind and Envoy Gateway",
      "bash",
      ["scripts/kubernetes/bootstrap-kind.sh"],
      childEnvironment,
    );
    const registryHost = resolveLocalRegistryHost(childEnvironment, plan.registryPort);
    childEnvironment.PREVIEWFORGE_REGISTRY_HOST = registryHost;
    childEnvironment.REGISTRY_HOST = registryHost;
    childEnvironment.CONTAINER_REGISTRY = registryHost;
    state.registryHost = registryHost;
    await writeState(stateDirectory, state);
    console.log(`[local] registry endpoint: ${registryHost}`);
    await runStep(
      "connect the local registry to kind",
      "bash",
      ["scripts/kubernetes/connect-local-registry.sh"],
      childEnvironment,
    );
    state.kubeconfig = await writeKubeconfig(stateDirectory, childEnvironment, state.clusterName);
    childEnvironment.KUBECONFIG = state.kubeconfig;
    childEnvironment.KUBE_CONTEXT = `kind-${state.clusterName}`;
    await writeState(stateDirectory, state);

    const gateway = spawnTracked(
      "gateway-port-forward",
      "bash",
      ["scripts/kubernetes/gateway-port-forward.sh"],
      childEnvironment,
      join(paths.logs, "gateway.log"),
    );
    state.children.push({
      name: gateway.name,
      pid: gateway.pid,
      managed: true,
      logPath: gateway.logPath,
    });
    await writeState(stateDirectory, state);
    await waitForTcp(plan.gatewayPort, "127.0.0.1");
    watchUnexpectedExit(gateway, cleanup);

    const app = spawnTracked(
      "previewforge-dev",
      "pnpm",
      ["dev"],
      childEnvironment,
      join(paths.logs, "previewforge-dev.log"),
    );
    state.children.push({ name: app.name, pid: app.pid, managed: true, logPath: app.logPath });
    await writeState(stateDirectory, state);
    await waitForHttp(
      `http://127.0.0.1:${plan.apiPort}/health`,
      (body) => body.includes('"status":"ok"'),
      "API health",
    );
    await waitForHttp(
      `http://127.0.0.1:${plan.workerPort}/health`,
      (body) => body.includes('"status":"ok"'),
      "worker health",
    );
    await waitForHttp(
      `http://127.0.0.1:${plan.webPort}`,
      (body) => body.length > 0,
      "web dashboard",
    );
    watchUnexpectedExit(app, cleanup);
    state.readyAt = new Date().toISOString();
    await writeState(stateDirectory, state);
    console.log(`PreviewForge local runtime is ready: http://127.0.0.1:${plan.webPort}`);
    console.log(`API health: http://127.0.0.1:${plan.apiPort}/health`);
    console.log(`Gateway: http://127.0.0.1:${plan.gatewayPort}`);
    console.log("Press Ctrl-C to stop only the owned local runtime.");
    await new Promise(() => {});
  } catch (error) {
    console.error(`[local] ${describeError(error)}`);
    await cleanup(1);
    throw error;
  }
}

async function status(options = {}) {
  const environment = options.environment ?? (await loadLocalEnvironment());
  const stateDirectory =
    options.stateDirectory ?? resolveStateDirectory(environment.PREVIEWFORGE_LOCAL_STATE_DIR);
  const state = options.state ?? (await readState(stateDirectory));
  if (!state) {
    console.log("PreviewForge local runtime: stopped");
    return { running: false };
  }
  const runtimeEnvironment = environmentForState(environment, state);
  const processes = Object.fromEntries(
    (state.children ?? []).map((child) => [child.name, isProcessAlive(child.pid)]),
  );
  const ports = {};
  for (const [name, port] of Object.entries(state.ports ?? {})) {
    ports[name] = await waitForTcp(port, "127.0.0.1", 250)
      .then(() => true)
      .catch(() => false);
  }
  const boundaries = {
    buildkit: (() => {
      try {
        const { socketPath } = parseBuildkitAddress(state.buildkitAddress);
        if (!existsSync(socketPath) || !commandExists("buildctl")) return false;
        runSync("buildctl", ["--addr", state.buildkitAddress, "debug", "workers"], {
          env: buildkitEnvironment(runtimeEnvironment),
        });
        return true;
      } catch {
        return undefined;
      }
    })(),
    postgres: undefined,
    kafka: undefined,
    registry: undefined,
    kind: undefined,
  };
  try {
    const composeContainers = inspectComposeContainers(runtimeEnvironment, { all: false });
    boundaries.postgres = Boolean(composeContainers.postgres);
    boundaries.kafka = Boolean(composeContainers.kafka);
    boundaries.registry = Boolean(composeContainers.registry);
  } catch {
    // Keep status read-only and redacted when Docker is temporarily unavailable.
  }
  try {
    const clusters = runSync("kind", ["get", "clusters"], { env: runtimeEnvironment });
    boundaries.kind = clusters.split(/\r?\n/u).some((name) => name.trim() === state.clusterName);
  } catch {
    // Keep status read-only and redacted when kind is temporarily unavailable.
  }
  const running = isProcessAlive(state.supervisorPid);
  console.log(`PreviewForge local runtime: ${running ? "running" : "stale"}`);
  console.log(`  state: ${state.stateDirectory}`);
  console.log(`  supervisor: ${state.supervisorPid} (${running ? "alive" : "dead"})`);
  for (const [name, alive] of Object.entries(processes))
    console.log(`  process ${name}: ${alive ? "alive" : "dead"}`);
  for (const [name, listening] of Object.entries(ports))
    console.log(`  port ${name}: ${listening ? "ready" : "closed"}`);
  for (const [name, ready] of Object.entries(boundaries)) {
    const label = ready === true ? "ready" : ready === false ? "down" : "unknown";
    console.log(`  boundary ${name}: ${label}`);
  }
  return { running, processes, ports, boundaries, state };
}

async function down() {
  const environment = await loadLocalEnvironment();
  const stateDirectory = resolveStateDirectory(environment.PREVIEWFORGE_LOCAL_STATE_DIR);
  const state = await readState(stateDirectory);
  if (!state) {
    console.log("PreviewForge local runtime: already stopped");
    return;
  }
  const runtimeEnvironment = environmentForState(environment, state);
  if (state.supervisorPid !== process.pid && isProcessAlive(state.supervisorPid)) {
    try {
      process.kill(state.supervisorPid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await assertOwnership(stateDirectory))) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (await assertOwnership(stateDirectory))
      throw new Error("local runtime supervisor did not stop; refusing teardown while it is alive");
    console.log("PreviewForge local runtime stopped");
    return;
  }
  shuttingDown = true;
  await terminateTrackedChildren(state);
  await stopOwnedComposeServices(runtimeEnvironment, state.ownedComposeServices).catch((error) =>
    console.error(`[local] ${error.message}`),
  );
  if (state.clusterCreated)
    await runStep(
      "delete owned kind cluster",
      "kind",
      ["delete", "cluster", "--name", state.clusterName],
      runtimeEnvironment,
    ).catch((error) => console.error(`[local] ${error.message}`));
  if (!(await removeOwnedState(stateDirectory))) {
    throw new Error("Refusing to remove local runtime state after ownership changed");
  }
  console.log("PreviewForge local runtime stopped");
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || !["up", "status", "down"].includes(command)) {
    console.error("Usage: node scripts/local/runtime.mjs <up|status|down>");
    return 2;
  }
  if (command === "up") await up();
  if (command === "status") await status();
  if (command === "down") await down();
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[local] ${describeError(error)}`);
      process.exitCode = 1;
    });
}
