import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const fixtureRoot = join(repositoryRoot, "fixtures/m8");
const forbiddenContent = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /xox[baprs]-[A-Za-z0-9-]{20,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
];
const allowedActions = new Set(["opened", "reopened", "synchronize", "closed"]);
const expectedTopics = new Set([
  "previewforge.deployment-requests.v1",
  "previewforge.deployment-events.v1",
  "previewforge.environment-commands.v1",
]);

const errors = [];
const referencedFiles = new Set();
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

function requirePositiveDecimal(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value))) {
    error(`${label} must be a positive decimal identity`);
  }
}

function requireSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) {
    error(`${label} must be a 40-character hex SHA`);
  }
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
    error(`${label} must be a relative path inside fixtures/m8`);
    return false;
  }
  return true;
}

async function requireFile(value, label) {
  if (!requireRelativePath(value, label)) return;
  if (referencedFiles.has(value)) return;
  referencedFiles.add(value);
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
  if (!Number.isInteger(payload.number) || payload.number <= 0) {
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
  if (manifest.repository?.pullRequestNumber !== 8) {
    error("repository.pullRequestNumber must remain the stable M8 fixture number 8");
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
    const payload = await readJson(descriptor.path);
    checkWebhookPayload(payload, descriptor);
  }

  await requireFile(manifest.github?.httpCasesPath, "github.httpCasesPath");
  const httpCases = await readJson(manifest.github.httpCasesPath);
  for (const item of [
    ...(httpCases.webhookCases ?? []),
    ...(httpCases.sourceCases ?? []),
    ...(httpCases.checkRunCases ?? []),
  ]) {
    if (item.payloadPath) await requireFile(item.payloadPath, `HTTP case ${item.id} payloadPath`);
    if (item.responsePath)
      await requireFile(item.responsePath, `HTTP case ${item.id} responsePath`);
    if (item.archivePath)
      await requireDirectory(item.archivePath, `HTTP case ${item.id} archivePath`);
  }

  for (const response of manifest.github?.checkRunResponses ?? []) {
    await requireFile(response.path, `Check Run ${response.id} path`);
    const payload = await readJson(response.path);
    if (payload.conclusion !== response.conclusion) {
      error(`Check Run ${response.id} conclusion does not match its descriptor`);
    }
  }

  const sourceIds = new Set();
  for (const source of manifest.source ?? []) {
    if (sourceIds.has(source.id)) error(`duplicate source fixture id: ${source.id}`);
    sourceIds.add(source.id);
    await requireDirectory(source.path, `source ${source.id} path`);
    await requireFile(`${source.path}/${source.dockerfilePath}`, `source ${source.id} Dockerfile`);
    if (!source.healthPath.startsWith("/")) error(`source ${source.id} healthPath is not absolute`);
    if (
      !new Set(["build-and-health-success", "build-failure", "health-check-failure"]).has(
        source.expectedOutcome,
      )
    ) {
      error(`source ${source.id} has an unsupported expected outcome`);
    }
  }

  await requireFile(manifest.runtime?.retryableUpstreamPath, "runtime.retryableUpstreamPath");
  const retryableUpstream = await readJson(manifest.runtime.retryableUpstreamPath);
  if (retryableUpstream.expected?.firstErrorCode !== "SOURCE_RATE_LIMITED") {
    error("retryable upstream fixture must begin with SOURCE_RATE_LIMITED");
  }
  if (retryableUpstream.expected?.firstRetryable !== true) {
    error("retryable upstream fixture must be retryable");
  }

  const topics = manifest.kafka?.topics;
  if (!Array.isArray(topics) || new Set(topics).size !== expectedTopics.size) {
    error("Kafka topic list must contain each M8 topic exactly once");
  } else {
    for (const topic of expectedTopics) {
      if (!topics.includes(topic)) error(`Kafka topic is missing: ${topic}`);
    }
  }
  if (manifest.ownership?.label !== "previewforge.dev/m8-fixture") {
    error("ownership label is not the M8 fixture label");
  }
  if (manifest.ownership?.value !== manifest.fixtureId) {
    error("ownership value must equal fixtureId");
  }
  if (manifest.restore?.authoritativeStore !== "postgresql") {
    error("PostgreSQL must remain the authoritative restore source");
  }
  if (manifest.restore?.transportReplay !== "outbox-to-kafka") {
    error("Kafka restore must be described as outbox-to-Kafka replay");
  }
}

await checkManifest();

if (errors.length > 0) {
  console.error(`M8 fixture manifest invalid (${errors.length} error(s))`);
  for (const message of errors) console.error(`- ${message}`);
  process.exitCode = 1;
} else if (process.argv.includes("--print")) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(
    `M8 fixture manifest OK: ${manifest.github.webhookPayloads.length} webhook payloads, ${manifest.source.length} source contexts, ${manifest.kafka.topics.length} Kafka topics`,
  );
}
