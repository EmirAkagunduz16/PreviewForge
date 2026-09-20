import type { DeploymentFeedbackContext, DeploymentFeedbackLock } from "@previewforge/database";
import { describe, expect, it } from "vitest";
import type { PreviewUrlConfig } from "../preview-url.js";
import { GitHubCheckRunError, type GitHubCheckRunRequest } from "./client.js";
import {
  type DeploymentFeedbackEvent,
  GITHUB_CHECK_RUN_NAME,
  GitHubCheckRunCoordinator,
} from "./coordinator.js";

const ids = {
  deployment: "33333333-3333-4333-8333-333333333333",
  environment: "22222222-2222-4222-8222-222222222222",
  event: "11111111-1111-4111-8111-111111111111",
};
const sha = "a".repeat(40);

function context(overrides: Partial<DeploymentFeedbackContext> = {}): DeploymentFeedbackContext {
  return {
    deploymentId: ids.deployment,
    environmentId: ids.environment,
    commitSha: sha,
    desiredCommitSha: sha,
    status: "READY",
    failureStage: null,
    failureCode: null,
    failureMessage: null,
    failureRetryable: null,
    checkRunId: null,
    imageDigest: `sha256:${"b".repeat(64)}`,
    repositoryFullName: "acme/store",
    installationId: "42",
    pullRequestNumber: 7,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): DeploymentFeedbackEvent {
  return {
    eventId: ids.event,
    eventType: "deployment.ready.v1",
    occurredAt: "2026-09-17T12:00:00.000Z",
    deploymentId: ids.deployment,
    environmentId: ids.environment,
    commitSha: sha,
    fromStatus: "WAITING_FOR_HEALTHCHECK",
    toStatus: "READY",
    ...overrides,
  } as DeploymentFeedbackEvent;
}

class FakeRepository {
  current = context();
  readonly processed = new Set<string>();

  async withDeploymentLock<T>(
    _deploymentId: string,
    callback: (lock: DeploymentFeedbackLock) => Promise<T>,
  ): Promise<T> {
    return callback({
      context: this.current,
      isEventProcessed: async (eventId) => this.processed.has(eventId),
      markEventProcessed: async (eventId) => {
        this.processed.add(eventId);
      },
      storeCheckRunId: async (checkRunId) => {
        if (this.current.checkRunId !== null && this.current.checkRunId !== checkRunId) {
          throw new Error("conflicting check run");
        }
        this.current = { ...this.current, checkRunId };
      },
    });
  }
}

class FakeClient {
  readonly creates: GitHubCheckRunRequest[] = [];
  readonly updates: Array<GitHubCheckRunRequest & { checkRunId: string }> = [];
  readonly lists: GitHubCheckRunRequest[] = [];
  remote: Array<{ id: string; externalId: string }> = [];
  loseCreateResponse = false;

  async list(input: GitHubCheckRunRequest) {
    this.lists.push(input);
    return this.remote.map((run) => ({
      id: run.id,
      externalId: run.externalId,
      status: "completed" as const,
      conclusion: "success" as const,
    }));
  }

  async create(input: GitHubCheckRunRequest) {
    this.creates.push(input);
    const created = { id: "101", externalId: input.externalId };
    this.remote.push(created);
    if (this.loseCreateResponse) {
      throw new GitHubCheckRunError("CHECKS_UPSTREAM_FAILURE", true, 503);
    }
    return {
      id: created.id,
      externalId: created.externalId,
      status: input.status,
      conclusion: input.conclusion ?? null,
    };
  }

  async update(input: GitHubCheckRunRequest & { checkRunId: string }) {
    this.updates.push(input);
    return {
      id: input.checkRunId,
      externalId: input.externalId,
      status: input.status,
      conclusion: input.conclusion ?? null,
    };
  }
}

function coordinator(
  repository: FakeRepository,
  client: FakeClient,
  previewUrlConfig: PreviewUrlConfig = { baseDomain: "preview.example.test", scheme: "https" },
) {
  return new GitHubCheckRunCoordinator({
    repository,
    client,
    previewUrlConfig,
    consumerName: "worker:github-checks",
  });
}

describe("GitHubCheckRunCoordinator", () => {
  it("creates once, stores the identity, and publishes the immutable digest and preview URL", async () => {
    const repository = new FakeRepository();
    const client = new FakeClient();

    await expect(coordinator(repository, client).process(event())).resolves.toBe("PROCESSED");
    expect(client.creates).toHaveLength(1);
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toMatchObject({
      checkRunId: "101",
      status: "completed",
      conclusion: "success",
    });
    expect(client.updates[0]?.summary).toContain(
      "https://preview-22222222-2222-4222-8222-222222222222.preview.example.test/",
    );
    expect(client.updates[0]?.summary).toContain(`sha256:${"b".repeat(64)}`);
    expect(repository.current.checkRunId).toBe("101");
    expect(repository.processed).toContain(ids.event);
  });

  it("treats a repeated event receipt as a no-op after the first Check Run update", async () => {
    const repository = new FakeRepository();
    const client = new FakeClient();
    const checks = coordinator(repository, client);

    await expect(checks.process(event())).resolves.toBe("PROCESSED");
    await expect(checks.process(event())).resolves.toBe("DUPLICATE");

    expect(client.creates).toHaveLength(1);
    expect(client.updates).toHaveLength(1);
  });

  it("recovers a remote Check Run after create response loss before updating it", async () => {
    const repository = new FakeRepository();
    const client = new FakeClient();
    client.loseCreateResponse = true;

    await expect(coordinator(repository, client).process(event())).resolves.toBe("PROCESSED");
    expect(client.creates).toHaveLength(1);
    expect(client.lists).toHaveLength(2);
    expect(client.updates).toHaveLength(1);
    expect(repository.current.checkRunId).toBe("101");
  });

  it("uses the authoritative current state instead of a delayed event status", async () => {
    const repository = new FakeRepository();
    repository.current = context({
      status: "FAILED",
      failureStage: "BUILDING",
      failureCode: "BUILD_FAILED",
      failureMessage: "safe failure",
      failureRetryable: false,
    });
    const client = new FakeClient();

    await coordinator(repository, client).process(
      event({
        eventId: "44444444-4444-4444-8444-444444444444",
        eventType: "deployment.stage-changed.v1",
        fromStatus: "BUILDING",
        toStatus: "PUSHING",
      }),
    );
    expect(client.updates[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(client.updates[0]?.summary).toContain("BUILD_FAILED");
  });

  it("publishes the local Gateway port without changing the route hostname", async () => {
    const repository = new FakeRepository();
    const client = new FakeClient();

    await coordinator(repository, client, {
      baseDomain: "preview.localhost",
      scheme: "http",
      localPort: 18080,
    }).process(event());

    const expectedUrl =
      "http://preview-22222222-2222-4222-8222-222222222222.preview.localhost:18080/";
    expect(client.updates[0]?.summary).toContain(expectedUrl);
    expect(client.updates[0]?.detailsUrl).toBe(expectedUrl);
    expect(client.updates[0]?.summary).toContain(
      "preview-22222222-2222-4222-8222-222222222222.preview.localhost:18080",
    );
  });

  it("redacts credential-shaped failure text before Check Run output", async () => {
    const repository = new FakeRepository();
    repository.current = context({
      status: "FAILED",
      failureStage: "SOURCE",
      failureCode: "SOURCE_FAILED",
      failureMessage: "authorization Bearer ghp_should-not-leak",
      failureRetryable: true,
    });
    const client = new FakeClient();

    await coordinator(repository, client).process(
      event({
        eventId: "55555555-5555-4555-8555-555555555555",
        eventType: "deployment.failed.v1",
        fromStatus: "BUILDING",
        toStatus: "FAILED",
      }),
    );
    expect(client.updates[0]?.summary).toContain("[REDACTED]");
    expect(client.updates[0]?.summary).not.toContain("ghp_should-not-leak");
  });

  it("reports a stale desired SHA as neutral even before supersession is observed", async () => {
    const repository = new FakeRepository();
    repository.current = context({ desiredCommitSha: "c".repeat(40), status: "READY" });
    const client = new FakeClient();

    await coordinator(repository, client).process(
      event({ eventId: "66666666-6666-4666-8666-666666666666" }),
    );
    expect(client.updates[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      name: GITHUB_CHECK_RUN_NAME,
    });
  });
});
