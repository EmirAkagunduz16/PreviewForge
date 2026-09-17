import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export type M8GithubFixtureIds = {
  installationId: string;
  repositoryId: string;
  pullRequestId: string;
  repositoryFullName: string;
};

const fixtureRoot = new URL("../../../../../fixtures/m8/github/", import.meta.url);

export function loadGithubWebhookFixture(
  filename: string,
  ids: M8GithubFixtureIds,
  replacements: { oldSha?: string; newSha?: string } = {},
): Buffer {
  let raw = readFileSync(new URL(filename, fixtureRoot), "utf8");
  raw = raw.replaceAll("1800008", ids.installationId);
  raw = raw.replaceAll("2800008", ids.repositoryId);
  raw = raw.replaceAll("3800008", ids.pullRequestId);
  raw = raw.replaceAll("previewforge/m8-fixtures", ids.repositoryFullName);
  if (replacements.oldSha !== undefined) {
    raw = raw.replaceAll("1111111111111111111111111111111111111111", replacements.oldSha);
  }
  if (replacements.newSha !== undefined) {
    raw = raw.replaceAll("2222222222222222222222222222222222222222", replacements.newSha);
  }
  return Buffer.from(raw);
}

export function githubSignature(rawBody: Buffer, webhookSecret: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
}
