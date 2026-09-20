import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureRoot = join(repositoryRoot, "fixtures/m9");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: loopback fixture controls are intentionally runtime-only.
const host = process.env.M9_GITHUB_FIXTURE_HOST ?? "127.0.0.1";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: loopback fixture controls are intentionally runtime-only.
const port = parsePort(process.env.M9_GITHUB_FIXTURE_PORT ?? "43129");
const stateDirectory = resolve(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: loopback fixture controls are intentionally runtime-only.
  process.env.M9_GITHUB_FIXTURE_STATE_DIR ?? "/tmp/previewforge-m9-github-fixture",
);
const repository = "previewforge/m9-fixtures";
const installationId = "1900009";
const repositoryId = "2900009";
const userId = "3900009";
const openedCommit = "9999999999999999999999999999999999999999";
const synchronizedCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const userToken = "m9-fixture-user-token";
const installationToken = "m9-fixture-installation-token";
const authorizationCode = "m9-fixture-one-time-code";
const checkRuns = new Map();
let nextCheckRunId = 5_900_009;
let archiveDirectory;
let archiveBytes;
let server;
let firstCheckCreate = true;

assertLoopbackHost(host);
await validateFixtureFiles();
await prepareStateDirectory();
archiveDirectory = await mkdtemp(join(tmpdir(), "previewforge-m9-github-archive-"));
const archivePath = join(archiveDirectory, "m9-fixtures.tar.gz");
await execFileAsync(
  "tar",
  [
    "--create",
    "--gzip",
    "--file",
    archivePath,
    "--directory",
    join(fixtureRoot, "source/app"),
    ".",
    "--no-same-owner",
    "--no-same-permissions",
  ],
  { cwd: repositoryRoot, maxBuffer: 64 * 1024 },
);
archiveBytes = await readFile(archivePath);

server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status =
      Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
    json(response, status, {
      message: status === 500 ? "fixture request failed" : "fixture request rejected",
    });
  });
});
server.on("error", (error) => {
  console.error(
    `M9 GitHub fixture failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const origin = `http://${hostForUrl(host)}:${port}`;
  console.log(`M9 GitHub fixture listening at ${origin}`);
  console.log(
    JSON.stringify({
      apiBaseUrl: origin,
      oauthBaseUrl: origin,
      installationId,
      repositoryId,
      repository,
      sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      webhookSecretName: "GITHUB_WEBHOOK_SECRET",
      stateDirectory,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${hostForUrl(host)}:${port}`);
  if (request.method === "GET" && url.pathname === "/login/oauth/authorize") {
    return oauthAuthorize(url, response);
  }
  if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
    return oauthToken(request, response);
  }
  if (request.method === "GET" && url.pathname.startsWith("/apps/")) {
    return installationSetup(url, response);
  }
  if (request.method === "GET" && url.pathname === "/user") {
    requireBearer(request, userToken);
    return json(response, 200, { id: userId, login: "m9-local-user", name: "M9 local fixture" });
  }
  if (request.method === "GET" && url.pathname === `/user/installations/${installationId}`) {
    requireBearer(request, userToken);
    return json(response, 200, installationPayload());
  }
  if (request.method === "GET" && url.pathname === `/app/installations/${installationId}`) {
    requireBearer(request);
    return json(response, 200, installationPayload());
  }
  if (
    request.method === "GET" &&
    url.pathname === `/user/installations/${installationId}/repositories`
  ) {
    requireBearer(request, userToken);
    return listRepositories(url, response);
  }
  if (
    request.method === "POST" &&
    url.pathname === `/app/installations/${installationId}/access_tokens`
  ) {
    requireBearer(request);
    return json(response, 201, {
      token: installationToken,
      expires_at: "2099-01-01T00:00:00Z",
    });
  }
  if (request.method === "GET" && url.pathname === `/repos/${repository}/contents/Dockerfile`) {
    requireBearer(request, installationToken);
    return json(response, 200, { type: "file", path: "Dockerfile", sha: "m9-dockerfile" });
  }
  if (
    request.method === "GET" &&
    new RegExp(
      `^/repos/${escapeRegExp(repository)}/tarball/(?:${openedCommit}|${synchronizedCommit})$`,
      "u",
    ).test(url.pathname)
  ) {
    requireBearer(request, installationToken);
    response.writeHead(302, { location: `/m9/source/archive.tar.gz` }).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/m9/source/archive.tar.gz") {
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": archiveBytes.byteLength,
    });
    response.end(archiveBytes);
    return;
  }
  if (request.method === "POST" && url.pathname === `/repos/${repository}/check-runs`) {
    return createCheckRun(request, response);
  }
  if (
    request.method === "GET" &&
    new RegExp(`^/repos/${escapeRegExp(repository)}/commits/[0-9a-f]{40}/check-runs$`, "iu").test(
      url.pathname,
    )
  ) {
    requireBearer(request);
    return json(response, 200, {
      total_count: checkRuns.size,
      check_runs: [...checkRuns.values()],
    });
  }
  const checkMatch = url.pathname.match(
    new RegExp(`^/repos/${escapeRegExp(repository)}/check-runs/([0-9]+)$`, "u"),
  );
  if (request.method === "PATCH" && checkMatch) {
    return updateCheckRun(checkMatch[1], request, response);
  }
  json(response, 404, { message: "fixture route not found" });
}

function oauthAuthorize(url, response) {
  const redirectUri = requiredLoopbackRedirect(url.searchParams.get("redirect_uri"));
  const state = url.searchParams.get("state");
  if (!state) return json(response, 400, { error: "state_required" });
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", authorizationCode);
  callback.searchParams.set("state", state);
  redirect(response, callback);
}

async function oauthToken(request, response) {
  const body = new URLSearchParams(await requestText(request));
  if (body.get("code") !== authorizationCode || !body.get("code_verifier")) {
    return json(response, 400, { error: "bad_verification_code" });
  }
  json(response, 200, { access_token: userToken, token_type: "bearer", scope: "" });
}

function installationSetup(url, response) {
  const redirectUri = requiredLoopbackRedirect(url.searchParams.get("redirect_uri"));
  const state = url.searchParams.get("state");
  if (!state) return json(response, 400, { error: "state_required" });
  const callback = new URL(redirectUri);
  callback.searchParams.set("installation_id", installationId);
  callback.searchParams.set("state", state);
  redirect(response, callback);
}

function listRepositories(url, response) {
  const page = url.searchParams.get("page");
  const repositories =
    page === "2"
      ? []
      : [
          repositoryPayload(repositoryId, "m9-fixtures", true),
          repositoryPayload("2900010", "m9-private-no-pull", false),
        ];
  const headers =
    page === null
      ? {
          link: `<http://${hostForUrl(host)}:${port}/user/installations/${installationId}/repositories?page=2>; rel="next"`,
        }
      : {};
  json(
    response,
    200,
    { total_count: repositories.length, incomplete_results: false, repositories },
    headers,
  );
}

async function createCheckRun(request, response) {
  requireBearer(request);
  const body = JSON.parse(await requestText(request));
  const id = String(nextCheckRunId++);
  const record = {
    id: Number(id),
    external_id: typeof body.external_id === "string" ? body.external_id : null,
    status: body.status,
    conclusion: body.conclusion ?? null,
  };
  checkRuns.set(id, record);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: fault injection is an explicit fixture-only control.
  if (process.env.M9_GITHUB_FIXTURE_DROP_FIRST_CHECK_CREATE === "true" && firstCheckCreate) {
    firstCheckCreate = false;
    response.destroy();
    return;
  }
  json(response, 201, record);
}

async function updateCheckRun(id, request, response) {
  requireBearer(request);
  const existing = checkRuns.get(id);
  if (!existing) return json(response, 404, { message: "check run not found" });
  const body = JSON.parse(await requestText(request));
  const record = {
    ...existing,
    status: body.status,
    conclusion: body.conclusion ?? null,
  };
  checkRuns.set(id, record);
  json(response, 200, record);
}

function installationPayload() {
  return {
    id: Number(installationId),
    account: { id: Number(userId), login: "m9-local-user", type: "User" },
  };
}

function repositoryPayload(id, name, pull) {
  return {
    id: Number(id),
    name,
    full_name: `previewforge/${name}`,
    private: true,
    default_branch: "main",
    permissions: { pull, push: false, admin: false },
  };
}

function requireBearer(request, expected) {
  const value = request.headers.authorization;
  if (expected !== undefined && value !== `Bearer ${expected}`) {
    throw httpError(401, "fixture token rejected");
  }
  if (expected === undefined && (typeof value !== "string" || !value.startsWith("Bearer "))) {
    throw httpError(401, "fixture token missing");
  }
}

function requiredLoopbackRedirect(value) {
  if (typeof value !== "string") throw httpError(400, "redirect_uri required");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, "redirect_uri invalid");
  }
  if (!isLoopbackHost(url.hostname) || !["http:", "https:"].includes(url.protocol)) {
    throw httpError(400, "redirect_uri must be loopback HTTP(S)");
  }
  return url.toString();
}

async function requestText(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw httpError(413, "fixture request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redirect(response, target) {
  response.writeHead(302, { location: target.toString() }).end();
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function prepareStateDirectory() {
  if (
    !/^\/(?:tmp|var\/tmp)\/previewforge-m9-github-fixture(?:-[A-Za-z0-9._-]+)?$/u.test(
      stateDirectory,
    )
  ) {
    throw new Error("M9_GITHUB_FIXTURE_STATE_DIR must be an exact /tmp or /var/tmp fixture path");
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(stateDirectory, "OWNED-BY-PREVIEWFORGE"),
    "previewforge-m9-github-fixture-v1\n",
    {
      mode: 0o600,
    },
  );
  await writeFile(
    join(stateDirectory, "state.json"),
    `${JSON.stringify({ fixtureId: "m9-local-demo", repository, installationId, host, port }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(stateDirectory, 0o700);
}

async function shutdown(signal) {
  if (server) await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  if (archiveDirectory) await rm(archiveDirectory, { recursive: true, force: true });
  await rm(stateDirectory, { recursive: true, force: true });
  console.log(`M9 GitHub fixture stopped (${signal})`);
}

async function validateFixtureFiles() {
  const dockerfile = await readFile(join(fixtureRoot, "source/app/Dockerfile"), "utf8");
  if (!dockerfile.includes("EXPOSE 8080")) throw new Error("M9 fixture Dockerfile is invalid");
}

function parsePort(value) {
  if (!/^\d+$/u.test(value)) throw new Error("M9_GITHUB_FIXTURE_PORT must be numeric");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 65_535) {
    throw new Error("M9_GITHUB_FIXTURE_PORT must be between 1 and 65535");
  }
  return result;
}

function assertLoopbackHost(value) {
  if (!isLoopbackHost(value)) throw new Error("M9 GitHub fixture must bind to loopback");
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function hostForUrl(value) {
  return value.includes(":") ? `[${value}]` : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
