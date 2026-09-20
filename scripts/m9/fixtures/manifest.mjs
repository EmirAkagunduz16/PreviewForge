import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const fixtureRoot = join(repositoryRoot, "fixtures/m9");
const forbiddenContent = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /xox[baprs]-[A-Za-z0-9-]{20,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
];
const allowedActions = new Set(["opened", "reopened", "synchronize", "closed"]);
const errors = [];
const manifest = await readJson("manifest.json");

function error(message) {
  errors.push(message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    error(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) {
    error(`${label} must be a 40-character hex SHA`);
  }
}

function requirePositiveDecimal(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value))) error(`${label} must be a positive decimal identity`);
}

function requireRelativePath(value, label) {
  if (!requireString(value, label)) return false;
  const normalized = value.replaceAll("\\", "/");
  const target = resolve(fixtureRoot, value);
  const fromRoot = relative(fixtureRoot, target);
  if (
    normalized !== value ||
    value.startsWith("/") ||
    value.includes("\u0000") ||
    fromRoot.startsWith("..") ||
    fromRoot === ""
  ) {
    error(`${label} must be a relative path inside fixtures/m9`);
    return false;
  }
  return true;
}

async function requireFile(value, label) {
  if (!requireRelativePath(value, label)) return;
  try {
    const stat = await lstat(join(fixtureRoot, value));
    if (!stat.isFile()) {
      error(`${label} does not point to a regular file`);
      return;
    }
    const contents = await readFile(join(fixtureRoot, value), "utf8");
    for (const pattern of forbiddenContent) {
      if (pattern.test(contents)) error(`${label} contains a credential-shaped value`);
    }
  } catch {
    error(`${label} is missing: ${value}`);
  }
}

async function requireDirectory(value, label) {
  if (!requireRelativePath(value, label)) return;
  try {
    const stat = await lstat(join(fixtureRoot, value));
    if (!stat.isDirectory()) error(`${label} does not point to a directory`);
  } catch {
    error(`${label} is missing: ${value}`);
  }
}

async function readJson(value) {
  try {
    return JSON.parse(await readFile(join(fixtureRoot, value), "utf8"));
  } catch (cause) {
    error(`invalid JSON at ${value}: ${cause instanceof Error ? cause.message : "unknown error"}`);
    return {};
  }
}

function checkWebhookPayload(payload, descriptor) {
  const label = `webhook ${descriptor.id}`;
  if (!allowedActions.has(payload.action)) error(`${label} has an unsupported action`);
  if (!Number.isInteger(payload.number) || payload.number !== 9) {
    error(`${label} pull-request number is invalid`);
  }
  requirePositiveDecimal(payload.installation?.id, `${label} installation id`);
  requirePositiveDecimal(payload.repository?.id, `${label} repository id`);
  if (payload.repository?.full_name !== manifest.repository.repositoryFullName) {
    error(`${label} repository does not match the manifest`);
  }
  requireSha(payload.pull_request?.head?.sha, `${label} head SHA`);
  if (payload.pull_request?.head?.sha !== descriptor.commitSha) {
    error(`${label} head SHA does not match its descriptor`);
  }
  if (typeof payload.pull_request?.updated_at !== "string") {
    error(`${label} source timestamp is invalid`);
  }
}

async function checkManifest() {
  if (manifest.schemaVersion !== 1) error("manifest schemaVersion must be 1");
  requireString(manifest.fixtureId, "fixtureId");
  requireString(manifest.repository?.repositoryFullName, "repository.repositoryFullName");
  requirePositiveDecimal(manifest.repository?.installationId, "repository.installationId");
  requirePositiveDecimal(manifest.repository?.repositoryId, "repository.repositoryId");
  requirePositiveDecimal(manifest.repository?.pullRequestId, "repository.pullRequestId");
  if (manifest.repository?.pullRequestNumber !== 9) {
    error("repository.pullRequestNumber must remain the stable M9 fixture number 9");
  }

  for (const [name, sha] of Object.entries(manifest.commits ?? {})) {
    requireSha(sha, `commits.${name}`);
  }

  const payloadIds = new Set();
  for (const descriptor of manifest.github?.webhookPayloads ?? []) {
    if (payloadIds.has(descriptor.id)) error(`duplicate webhook payload id: ${descriptor.id}`);
    payloadIds.add(descriptor.id);
    requireString(descriptor.deliveryId, `webhook ${descriptor.id} deliveryId`);
    await requireFile(descriptor.path, `webhook ${descriptor.id} path`);
    checkWebhookPayload(await readJson(descriptor.path), descriptor);
  }

  await requireFile(manifest.github?.httpCasesPath, "github.httpCasesPath");
  const httpCases = await readJson(manifest.github.httpCasesPath);
  for (const item of [...(httpCases.webhookCases ?? [])]) {
    if (item.payloadPath) await requireFile(item.payloadPath, `HTTP case ${item.id} payloadPath`);
    if (!Number.isInteger(item.repeat) || item.repeat < 1)
      error(`HTTP case ${item.id} repeat is invalid`);
  }
  for (const response of manifest.github?.checkRunResponses ?? []) {
    await requireFile(response.path, `Check Run ${response.id} path`);
    const payload = await readJson(response.path);
    if (payload.conclusion !== response.conclusion) {
      error(`Check Run ${response.id} conclusion does not match its descriptor`);
    }
  }

  await requireDirectory(manifest.source?.path, "source.path");
  await requireFile(
    `${manifest.source?.path}/${manifest.source?.dockerfilePath}`,
    "source Dockerfile",
  );
  if (manifest.source?.healthPath !== "/health") error("source healthPath must be /health");
  await requireFile(`${manifest.source?.path}/server.mjs`, "source server");
  if (manifest.source?.expectedOutcome !== "build-and-health-success") {
    error("source expectedOutcome is invalid");
  }

  if (manifest.ownership?.label !== "previewforge.dev/m9-fixture") {
    error("ownership label is not the M9 fixture label");
  }
  if (manifest.ownership?.value !== manifest.fixtureId) {
    error("ownership value must equal fixtureId");
  }
  if (!Array.isArray(manifest.journey) || manifest.journey.length < 10) {
    error("journey must list the complete local product path");
  }
}

await checkManifest();

if (errors.length > 0) {
  console.error(`M9 fixture manifest invalid (${errors.length} error(s))`);
  for (const message of errors) console.error(`- ${message}`);
  process.exitCode = 1;
} else if (process.argv.includes("--print")) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(
    `M9 fixture manifest OK: ${manifest.github.webhookPayloads.length} webhook payloads, ${manifest.journey.length} journey stages, loopback GitHub fixture enabled`,
  );
}

if (process.argv.includes("--scan")) {
  const files = await allFiles(fixtureRoot);
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const pattern of forbiddenContent) {
      if (pattern.test(contents))
        error(`fixture file contains a credential-shaped value: ${relative(fixtureRoot, file)}`);
    }
  }
  if (errors.length > 0) process.exitCode = 1;
}

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
