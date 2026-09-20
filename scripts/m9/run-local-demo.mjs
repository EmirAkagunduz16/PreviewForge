import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureRoot = join(repositoryRoot, "fixtures/m9");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: the demo target is an explicit loopback-only runtime input.
const apiOrigin = process.env.M9_API_ORIGIN ?? "http://127.0.0.1:4000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));

assertLoopbackOrigin(apiOrigin);
if (typeof webhookSecret !== "string" || webhookSecret.length < 8) {
  throw new Error("GITHUB_WEBHOOK_SECRET must be supplied from the controlled fixture environment");
}

await healthCheck();
const results = [];
const opened = await sendPayload("github/pull-request-opened.json", "m9-demo-opened-v1");
results.push({ name: "opened", duplicate: opened.duplicate === true, status: opened.status });
const duplicateOpened = await sendPayload("github/pull-request-opened.json", "m9-demo-opened-v1");
results.push({
  name: "duplicate-opened",
  duplicate: duplicateOpened.duplicate === true,
  status: duplicateOpened.status,
});
const synchronized = await sendPayload(
  "github/pull-request-synchronize.json",
  "m9-demo-synchronize-v1",
);
results.push({
  name: "synchronize",
  duplicate: synchronized.duplicate === true,
  status: synchronized.status,
});
const staleOpened = await sendPayload("github/pull-request-opened.json", "m9-demo-stale-opened-v1");
results.push({
  name: "stale-opened",
  stale: staleOpened.stale === true,
  status: staleOpened.status,
});
const closed = await sendPayload("github/pull-request-closed.json", "m9-demo-closed-v1");
results.push({ name: "closed", duplicate: closed.duplicate === true, status: closed.status });
const duplicateClosed = await sendPayload("github/pull-request-closed.json", "m9-demo-closed-v1");
results.push({
  name: "duplicate-closed",
  duplicate: duplicateClosed.duplicate === true,
  status: duplicateClosed.status,
});

const negative = await sendPayload(
  "github/pull-request-opened.json",
  "m9-demo-invalid-signature-v1",
  {
    signatureBody: pretty(await readFixture("github/pull-request-opened.json")),
    signature: signature(await readFixture("github/pull-request-opened.json")),
  },
);
if (negative.status !== 401)
  throw new Error(`invalid signature expected 401, got ${negative.status}`);

const expected = {
  opened: { status: 201, duplicate: false },
  "duplicate-opened": { status: 201, duplicate: true },
  synchronize: { status: 201, duplicate: false },
  "stale-opened": { status: 201, stale: true },
  closed: { status: 201, duplicate: false },
  "duplicate-closed": { status: 201, duplicate: true },
};
for (const result of results) {
  const expectation = expected[result.name];
  if (result.status !== expectation.status) {
    throw new Error(`${result.name} expected HTTP ${expectation.status}, got ${result.status}`);
  }
  for (const [key, value] of Object.entries(expectation)) {
    if (key !== "status" && result[key] !== value) {
      throw new Error(`${result.name} expected ${key}=${String(value)}`);
    }
  }
}

console.log(
  JSON.stringify(
    {
      fixtureId: manifest.fixtureId,
      apiOrigin,
      scenarios: results,
      invalidSignatureStatus: negative.status,
      note: "Webhook lifecycle boundary passed; browser, worker, Gateway, and teardown evidence still require the full local runtime.",
    },
    null,
    2,
  ),
);

async function sendPayload(filename, deliveryId, options = {}) {
  const raw = options.signatureBody ?? (await readFixture(filename));
  const signedBody = await readFixture(filename);
  const signatureValue = options.signature ?? signature(signedBody);
  const response = await fetch(`${apiOrigin}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signatureValue,
    },
    body: raw,
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Keep the error output bounded and secret-free.
  }
  return { status: response.status, ...(isRecord(body) ? body : {}) };
}

async function healthCheck() {
  const response = await fetch(`${apiOrigin}/health`);
  if (!response.ok) throw new Error(`API health check failed with HTTP ${response.status}`);
}

async function readFixture(filename) {
  return Buffer.from(await readFile(join(fixtureRoot, filename)));
}

function pretty(raw) {
  return Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8")), null, 2));
}

function signature(raw) {
  return `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`;
}

function assertLoopbackOrigin(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("M9_API_ORIGIN must be loopback");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("M9_API_ORIGIN must be a clean loopback origin");
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
