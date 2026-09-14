import { describe, expect, it, vi } from "vitest";
import {
  GitHubSourceClient,
  type GitHubSourceRequest,
  SourceAcquisitionError,
} from "./github-source.js";

const request: GitHubSourceRequest = {
  installationId: "42",
  repositoryFullName: "previewforge/demo",
  commitSha: "a".repeat(40),
  dockerfilePath: "Dockerfile",
};

describe("GitHubSourceClient", () => {
  it("fetches the exact commit archive with an installation token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const client = new GitHubSourceClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async (installationId) => {
        expect(installationId).toBe("42");
        return "installation-secret";
      },
      fetch: fetcher,
    });

    await expect(client.fetchArchive(request)).resolves.toMatchObject({
      repositoryFullName: request.repositoryFullName,
      commitSha: request.commitSha,
      dockerfilePath: "Dockerfile",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.github.test/repos/previewforge/demo/tarball/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-secret");
  });

  it("does not forward the token across the archive redirect", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://codeload.github.test/archive" },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    const client = new GitHubSourceClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: fetcher,
    });

    await client.fetchArchive(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://codeload.github.test/archive");
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it.each([
    ["bad installation", { installationId: "0" }],
    ["bad repository", { repositoryFullName: "previewforge/../private" }],
    ["bad SHA", { commitSha: "not-a-sha" }],
    ["path traversal", { dockerfilePath: "docker/../Dockerfile" }],
  ])("rejects unsafe %s input without a request", async (_label, override) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GitHubSourceClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: fetcher,
    });

    await expect(client.fetchArchive({ ...request, ...override })).rejects.toMatchObject({
      code: "SOURCE_INPUT_INVALID",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds archive responses and never exposes the token in the error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const client = new GitHubSourceClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: fetcher,
      maxArchiveBytes: 3,
    });

    const error = await client.fetchArchive(request).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SourceAcquisitionError);
    expect(error).toMatchObject({ code: "SOURCE_RESPONSE_TOO_LARGE", retryable: false });
    expect(String(error)).not.toContain("installation-secret");
  });

  it.each([
    [401, "SOURCE_UNAUTHORIZED", false],
    [403, "SOURCE_UNAUTHORIZED", false],
    [404, "SOURCE_NOT_FOUND", false],
    [429, "SOURCE_RATE_LIMITED", true],
    [500, "SOURCE_UPSTREAM_FAILURE", true],
  ])("maps GitHub status %s to a safe stable error", async (status, code, retryable) => {
    const client = new GitHubSourceClient({
      apiBaseUrl: "https://api.github.test",
      tokenProvider: async () => "installation-secret",
      fetch: async () => new Response(null, { status }),
    });
    await expect(client.fetchArchive(request)).rejects.toMatchObject({ code, retryable });
  });
});
