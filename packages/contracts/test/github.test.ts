import { describe, expect, it } from "vitest";
import {
  environmentDeletionRequestedSchema,
  githubOAuthTokenResponseSchema,
  githubPullRequestWebhookSchema,
  normalizePullRequestWebhookPayload,
  projectGithubOAuthToken,
  projectImportSchema,
} from "../src/github.js";

const validPullRequestPayload = {
  action: "synchronize",
  number: 42,
  installation: { id: "9007199254740993", secret: "drop-me" },
  repository: {
    id: "9007199254740994",
    full_name: "acme/store",
    clone_url: "https://github.example/acme/store.git",
  },
  pull_request: {
    id: "9007199254740995",
    number: 42,
    head: { sha: "a".repeat(40), repo: { private_key: "drop-me" } },
    updated_at: "2026-09-13T10:15:00.000Z",
    user: { access_token: "drop-me" },
  },
  sender: { token: "drop-me" },
};

describe("M2 GitHub boundary contracts", () => {
  it("normalizes pull_request events to an allow-listed safe DTO", () => {
    const normalized = normalizePullRequestWebhookPayload(validPullRequestPayload);

    expect(normalized).toEqual({
      action: "synchronize",
      installationId: "9007199254740993",
      repositoryId: "9007199254740994",
      repositoryFullName: "acme/store",
      pullRequestId: "9007199254740995",
      pullRequestNumber: 42,
      commitSha: "a".repeat(40),
      sourceTimestamp: "2026-09-13T10:15:00.000Z",
    });
    expect(normalized).not.toHaveProperty("secret");
    expect(JSON.stringify(normalized)).not.toContain("drop-me");
  });

  it("accepts only the four supported actions and exact SHAs", () => {
    expect(
      githubPullRequestWebhookSchema.safeParse({
        ...validPullRequestPayload,
        action: "edited",
      }).success,
    ).toBe(false);
    expect(
      githubPullRequestWebhookSchema.safeParse({
        ...validPullRequestPayload,
        pull_request: {
          ...validPullRequestPayload.pull_request,
          head: { sha: "short" },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps project-import IDs as strings while webhook IDs accept safe numbers", () => {
    expect(
      githubPullRequestWebhookSchema.safeParse({
        ...validPullRequestPayload,
        repository: { ...validPullRequestPayload.repository, id: 42 },
      }).success,
    ).toBe(true);
    expect(
      githubPullRequestWebhookSchema.safeParse({
        ...validPullRequestPayload,
        installation: { id: "0" },
      }).success,
    ).toBe(false);
    expect(
      projectImportSchema.safeParse({
        repositoryId: 42,
        repositoryFullName: "acme/store",
        dockerfilePath: "Dockerfile",
        port: 8080,
        healthPath: "/health",
      }).success,
    ).toBe(false);
  });

  it("normalizes realistic numeric GitHub webhook IDs without allowing precision loss", () => {
    const normalized = normalizePullRequestWebhookPayload({
      ...validPullRequestPayload,
      installation: { id: 123456789 },
      repository: { id: 987654321, full_name: "acme/store" },
      pull_request: {
        ...validPullRequestPayload.pull_request,
        id: 456789123,
      },
    });

    expect(normalized.installationId).toBe("123456789");
    expect(normalized.repositoryId).toBe("987654321");
    expect(normalized.pullRequestId).toBe("456789123");

    const safeMaximum = normalizePullRequestWebhookPayload({
      ...validPullRequestPayload,
      installation: { id: Number.MAX_SAFE_INTEGER },
      repository: { id: Number.MAX_SAFE_INTEGER, full_name: "acme/store" },
      pull_request: {
        ...validPullRequestPayload.pull_request,
        id: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(safeMaximum.installationId).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(safeMaximum.repositoryId).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(safeMaximum.pullRequestId).toBe(String(Number.MAX_SAFE_INTEGER));

    const largeDecimalString = normalizePullRequestWebhookPayload({
      ...validPullRequestPayload,
      installation: { id: "9007199254740993" },
      repository: { id: "9007199254740993", full_name: "acme/store" },
      pull_request: {
        ...validPullRequestPayload.pull_request,
        id: "9007199254740993",
      },
    });
    expect(largeDecimalString.installationId).toBe("9007199254740993");
    expect(largeDecimalString.repositoryId).toBe("9007199254740993");
    expect(largeDecimalString.pullRequestId).toBe("9007199254740993");

    for (const payload of [
      { ...validPullRequestPayload, installation: { id: Number.MAX_SAFE_INTEGER + 1 } },
      {
        ...validPullRequestPayload,
        repository: { id: Number.MAX_SAFE_INTEGER + 1, full_name: "acme/store" },
      },
      {
        ...validPullRequestPayload,
        pull_request: {
          ...validPullRequestPayload.pull_request,
          id: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ]) {
      expect(githubPullRequestWebhookSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("normalizes project import paths and rejects traversal, URLs, and invalid ports", () => {
    expect(
      projectImportSchema.parse({
        repositoryId: "123",
        repositoryFullName: "acme/store",
        dockerfilePath: "./docker/Dockerfile",
        port: 8080,
        healthPath: "/health/ready",
        access_token: "drop-me",
      }),
    ).toEqual({
      repositoryId: "123",
      repositoryFullName: "acme/store",
      dockerfilePath: "docker/Dockerfile",
      port: 8080,
      healthPath: "/health/ready",
    });

    for (const dockerfilePath of [
      "/Dockerfile",
      "../Dockerfile",
      "docker/../../Dockerfile",
      "docker\\Dockerfile",
    ]) {
      expect(
        projectImportSchema.safeParse({
          repositoryId: "123",
          repositoryFullName: "acme/store",
          dockerfilePath,
          port: 8080,
          healthPath: "/health",
        }).success,
      ).toBe(false);
    }
    for (const healthPath of ["https://example.test/health", "/health?ready=1", "/../health"]) {
      expect(
        projectImportSchema.safeParse({
          repositoryId: "123",
          repositoryFullName: "acme/store",
          dockerfilePath: "Dockerfile",
          port: 8080,
          healthPath,
        }).success,
      ).toBe(false);
    }
    expect(
      projectImportSchema.safeParse({
        repositoryId: "123",
        repositoryFullName: "acme/store",
        dockerfilePath: "Dockerfile",
        port: 65_536,
        healthPath: "/health",
      }).success,
    ).toBe(false);
  });

  it("projects OAuth token responses without retaining token values", () => {
    const response = {
      access_token: "ghu_secret",
      token_type: "bearer",
      scope: "repo",
      refresh_token: "ghr_secret",
      expires_in: 7_200,
      refresh_token_expires_in: 15_552_000,
      unexpected_secret: "drop-me",
    };
    expect(githubOAuthTokenResponseSchema.parse(response)).not.toHaveProperty("unexpected_secret");
    const metadata = projectGithubOAuthToken(response);
    expect(metadata).toEqual({
      tokenType: "bearer",
      scope: "repo",
      expiresInSeconds: 7_200,
      refreshTokenExpiresInSeconds: 15_552_000,
    });
    expect(JSON.stringify(metadata)).not.toContain("ghu_secret");
    expect(JSON.stringify(metadata)).not.toContain("ghr_secret");
  });

  it("accepts only the versioned deletion intent and strips unknown fields", () => {
    const event = environmentDeletionRequestedSchema.parse({
      eventId: "019930c0-c522-7474-a3f0-1ee461901c20",
      eventType: "environment.deletion-requested.v1",
      occurredAt: "2026-09-13T10:15:00.000Z",
      environmentId: "019930c0-c522-7474-a3f0-1ee461901c21",
      sourceTimestamp: "2026-09-13T10:14:59.000Z",
      projectId: "019930c0-c522-7474-a3f0-1ee461901c22",
      pullRequestNumber: 42,
      reason: "pull_request_closed",
      token: "drop-me",
    });
    expect(event).not.toHaveProperty("token");
    expect(
      environmentDeletionRequestedSchema.safeParse({
        ...event,
        eventType: "environment.deletion-requested.v2",
      }).success,
    ).toBe(false);
  });
});
