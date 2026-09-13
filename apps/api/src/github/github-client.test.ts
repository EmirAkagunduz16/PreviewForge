import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubAppJwt,
  GitHubApiError,
  GitHubClient,
  parseNextLink,
} from "./github-client.js";

describe("GitHubClient", () => {
  it("creates a short-lived RS256 App JWT", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = createGitHubAppJwt(
      "123",
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      1_700_000_000_000,
    );
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) throw new Error("JWT did not have three segments");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: "123",
      iat: 1_699_999_940,
      exp: 1_700_000_540,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("exchanges OAuth codes without assuming a token length", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("code=one-time-code");
      return new Response(
        JSON.stringify({ access_token: "x", token_type: "bearer", refresh_token: "short" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const client = new GitHubClient({
      appId: "123",
      privateKey: "unused",
      clientId: "client",
      clientSecret: "secret",
      fetch,
    });

    await expect(
      client.exchangeUserCode({ code: "one-time-code", codeVerifier: "verifier" }),
    ).resolves.toEqual({
      accessToken: "x",
      tokenType: "bearer",
      refreshToken: "short",
    });
  });

  it("parses the distinct installation-token response shape", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "x", expires_at: "2030-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new GitHubClient({ appId: "123", privateKey: "unused", fetch: request });

    await expect(client.createInstallationToken("9007199254740993", "jwt")).resolves.toEqual({
      accessToken: "x",
      expiresAt: "2030-01-01T00:00:00Z",
    });
  });

  it("handles repository envelopes, user installation access, and strict installation projections", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input.toString());
      if (url.pathname === "/installation/repositories") {
        return new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            repositories: [{ id: "00042", name: "repo", full_name: "octo/repo" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/user/installations/42/repositories") {
        if (url.searchParams.get("page") === "2") {
          return new Response(
            JSON.stringify({
              total_count: 3,
              incomplete_results: false,
              repositories: [
                {
                  id: 43,
                  name: "other",
                  full_name: "octo/other",
                  permissions: { pull: true, push: true, admin: true },
                },
                {
                  id: 44,
                  name: "third",
                  full_name: "octo/third",
                  permissions: { push: false },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            total_count: 3,
            incomplete_results: false,
            repositories: [
              {
                id: 42,
                name: "other",
                full_name: "octo/other",
                permissions: { pull: false, push: true, admin: true },
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
              link: '<https://api.github.com/user/installations/42/repositories?page=2>; rel="next"',
            },
          },
        );
      }
      if (url.pathname === "/user/installations/42") {
        return new Response(
          JSON.stringify({ id: "42", account: { id: 7, login: "octo", type: "Organization" } }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.pathname === "/user") {
        return new Response(JSON.stringify({ id: "0009", login: "octo", name: null }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/app/installations/42") {
        return new Response(
          JSON.stringify({ id: 42, account: { id: "7", login: "octo", type: "Organization" } }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = new GitHubClient({ appId: "123", privateKey: "unused", fetch: request });

    await expect(client.listInstallationRepositories("42", "token")).resolves.toEqual([
      { id: "42", name: "repo", fullName: "octo/repo" },
    ]);
    await expect(client.listUserInstallationRepositories("42", "user-token")).resolves.toEqual([
      { id: "42", name: "other", fullName: "octo/other", pull: false },
      { id: "43", name: "other", fullName: "octo/other", pull: true },
      { id: "44", name: "third", fullName: "octo/third" },
    ]);
    const listedRepositories = await client.listUserInstallationRepositories("42", "user-token");
    expect(listedRepositories.every((repository) => !("permissions" in repository))).toBe(true);
    await expect(client.getAuthenticatedUser("user-token")).resolves.toEqual({
      id: "9",
      login: "octo",
      name: null,
    });
    await expect(client.verifyUserInstallation("42", "user-token")).resolves.toEqual({
      id: "42",
      accountId: "7",
      accountLogin: "octo",
      accountType: "Organization",
    });
    await expect(client.verifyAppInstallation("42", "jwt")).resolves.toEqual({
      id: "42",
      accountId: "7",
      accountLogin: "octo",
      accountType: "Organization",
    });
  });

  it("rejects unsafe numeric repository IDs instead of stringifying rounded values", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: Number.MAX_SAFE_INTEGER + 1, name: "repo", full_name: "octo/repo" },
          ]),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = new GitHubClient({ appId: "123", privateKey: "unused", fetch: request });
    await expect(client.listUserRepositories("token")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("follows only same-origin GitHub pagination links", async () => {
    const request = vi.fn(async (url: RequestInfo | URL) =>
      (url instanceof URL ? url : new URL(url.toString())).searchParams.has("page")
        ? new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify([{ id: 99, name: "repo", full_name: "octo/repo" }]), {
            headers: {
              "content-type": "application/json",
              link: '<https://api.github.com/user/repos?page=2>; rel="next"',
            },
          }),
    );
    const client = new GitHubClient({ appId: "123", privateKey: "unused", fetch: request });
    await expect(client.listUserRepositories("token-of-any-length")).resolves.toEqual([
      { id: "99", name: "repo", fullName: "octo/repo" },
    ]);
    expect(request).toHaveBeenCalledTimes(2);

    expect(() =>
      parseNextLink('<https://evil.example/steal>; rel="next"', new URL("https://api.github.com/")),
    ).toThrow(GitHubApiError);
  });
});
