import { describe, expect, it, vi } from "vitest";
import {
  GitHubCheckRunClient,
  type GitHubCheckRunError,
  type GitHubCheckRunRequest,
} from "./client.js";

const request: GitHubCheckRunRequest = {
  installationId: "42",
  repositoryFullName: "acme/store",
  headSha: "a".repeat(40),
  name: "PreviewForge",
  externalId: "previewforge:deployment:22222222-2222-4222-8222-222222222222",
  status: "completed",
  conclusion: "success",
  title: "Preview deployment ready",
  summary: "Preview is ready",
  detailsUrl: "https://preview.example.test/",
};

function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GitHubCheckRunClient", () => {
  it("creates a Check Run with the stable external identity and no secret in the request body", async () => {
    let observed: Request | undefined;
    const client = new GitHubCheckRunClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: async (input, init) => {
        observed = new Request(input, init);
        return response(
          { id: 123, external_id: request.externalId, status: "completed", conclusion: "success" },
          201,
        );
      },
    });

    await expect(client.create(request)).resolves.toMatchObject({
      id: "123",
      externalId: request.externalId,
    });
    expect(observed?.method).toBe("POST");
    expect(observed?.url).toBe("https://api.github.test/repos/acme/store/check-runs");
    expect(observed?.headers.get("authorization")).toBe("Bearer installation-secret");
    expect(await observed?.json()).toMatchObject({
      name: "PreviewForge",
      external_id: request.externalId,
      head_sha: request.headSha,
      conclusion: "success",
    });
  });

  it("lists and updates only through the bounded GitHub API surface", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          check_runs: [
            { id: 99, external_id: request.externalId, status: "completed", conclusion: "success" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 99,
          external_id: request.externalId,
          status: "completed",
          conclusion: "success",
        }),
      );
    const client = new GitHubCheckRunClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: fetcher,
    });

    await expect(client.list(request)).resolves.toEqual([
      { id: "99", externalId: request.externalId, status: "completed", conclusion: "success" },
    ]);
    await expect(client.update({ ...request, checkRunId: "99" })).resolves.toMatchObject({
      id: "99",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("check_name=PreviewForge");
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "https://api.github.test/repos/acme/store/check-runs/99",
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer installation-secret",
    );
  });

  it.each([
    [401, false, "CHECKS_UNAUTHORIZED"],
    [403, false, "CHECKS_FORBIDDEN"],
    [403, true, "CHECKS_RATE_LIMITED"],
    [429, true, "CHECKS_RATE_LIMITED"],
    [500, true, "CHECKS_UPSTREAM_FAILURE"],
  ])(
    "classifies GitHub status %s without exposing the response body",
    async (status, retryable, code) => {
      const client = new GitHubCheckRunClient({
        apiBaseUrl: "https://api.github.test",
        tokenProvider: async () => "installation-secret",
        fetch: async () =>
          response(
            { message: "upstream-secret" },
            status,
            status === 403 && retryable ? { "x-ratelimit-remaining": "0" } : {},
          ),
      });
      const error = await client.create(request).catch((value: unknown) => value);
      expect(error).toMatchObject({ retryable, code });
      expect(String(error)).not.toContain("upstream-secret");
    },
  );

  it("fails closed on malformed successful responses", async () => {
    const client = new GitHubCheckRunClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: async () => response({ id: "not-a-check-run-id" }),
    });
    await expect(client.create(request)).rejects.toMatchObject<Partial<GitHubCheckRunError>>({
      code: "CHECKS_INVALID_RESPONSE",
      retryable: false,
    });
  });
});
