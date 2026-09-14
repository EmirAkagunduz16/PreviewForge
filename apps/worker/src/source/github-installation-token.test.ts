import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubInstallationTokenProvider,
  type InstallationTokenError,
} from "./github-installation-token.js";

describe("GitHubInstallationTokenProvider", () => {
  it("mints an App JWT and exchanges it without exposing the token in errors", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let request: Request | undefined;
    const provider = new GitHubInstallationTokenProvider({
      appId: "123",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiBaseUrl: "https://api.github.test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(JSON.stringify({ token: "ghs_secret-token" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(provider.getToken("42")).resolves.toBe("ghs_secret-token");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toMatch(/^Bearer ey/);
    expect(request?.url).toBe("https://api.github.test/app/installations/42/access_tokens");
  });

  it.each([
    [401, false],
    [429, true],
    [500, true],
  ])("maps GitHub status %s to a safe token error", async (status, retryable) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = new GitHubInstallationTokenProvider({
      appId: "123",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiBaseUrl: "https://api.github.test",
      fetch: async () => new Response("upstream-secret", { status }),
    });

    await expect(provider.getToken("42")).rejects.toMatchObject<Partial<InstallationTokenError>>({
      retryable,
      message: "GitHub installation token could not be acquired",
    });
  });
});
