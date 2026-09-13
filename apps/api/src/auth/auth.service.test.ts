import { describe, expect, it, vi } from "vitest";
import { CredentialCipher } from "../security/credential-cipher.js";
import { AuthService } from "./auth.service.js";
import type { AuthRepository, AuthRuntimeConfig, GitHubAuthAdapter } from "./auth.types.js";

const config: AuthRuntimeConfig = {
  clientId: "client-id",
  appSlug: "previewforge",
  publicBaseUrl: "https://previewforge.example",
  sessionTtlSeconds: 3600,
  oauthStateTtlSeconds: 600,
};

describe("AuthService", () => {
  it("binds OAuth state to a cookie, uses PKCE, and stores only encrypted credentials", async () => {
    const repository = new MemoryRepository();
    const github: GitHubAuthAdapter = {
      exchangeUserCode: vi.fn(async (input) => {
        expect(input.codeVerifier).toBeTruthy();
        return {
          accessToken: "access-token-secret",
          refreshToken: "refresh-token-secret",
          tokenType: "bearer",
          scope: "read:user",
          expiresIn: 300,
        };
      }),
      getAuthenticatedUser: vi.fn(async () => ({ id: "9007199254740993", login: "octo" })),
      verifyUserInstallation: vi.fn(),
      verifyAppInstallation: vi.fn(),
      createAppJwt: vi.fn(() => "jwt"),
    };
    const service = new AuthService(
      repository,
      github,
      new CredentialCipher(Buffer.alloc(32, 7)),
      config,
    );

    const start = await service.startSignIn();
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);

    const result = await service.finishSignIn(
      { code: "one-time-code", state: repository.lastState() },
      start.bindingCookieValue,
    );
    expect(result.user).toMatchObject({ githubUserId: "9007199254740993", githubLogin: "octo" });
    expect(repository.credential?.encryptedAccessToken).not.toContain("access-token-secret");
    expect(repository.credential?.encryptedRefreshToken).not.toContain("refresh-token-secret");
    expect(repository.sessionToken).toBe(result.sessionToken);
    await expect(
      service.finishSignIn(
        { code: "one-time-code", state: repository.lastState() },
        start.bindingCookieValue,
      ),
    ).rejects.toThrow(/state/i);
  });

  it("does not consume a state for a wrong binding cookie", async () => {
    const repository = new MemoryRepository();
    const service = new AuthService(
      repository,
      fakeGithub(),
      new CredentialCipher(Buffer.alloc(32)),
      config,
    );
    await service.startSignIn();
    await expect(
      service.finishSignIn({ code: "code", state: repository.lastState() }, "wrong-cookie"),
    ).rejects.toThrow(/state/i);
    expect(repository.consumed).toBe(false);
  });

  it("requires both user-scoped and app-scoped installation verification", async () => {
    const repository = new MemoryRepository();
    const github = fakeGithub();
    github.verifyUserInstallation = vi.fn(async () => {
      throw new Error("403 inaccessible");
    });
    const service = new AuthService(
      repository,
      github,
      new CredentialCipher(Buffer.alloc(32)),
      config,
    );
    const session = await service.startInstallation("session-token");
    await expect(
      service.finishInstallation(
        { installation_id: "42", state: repository.lastState() },
        session.bindingCookieValue,
        "session-token",
      ),
    ).rejects.toThrow(/could not be verified/i);
    expect(repository.claims).toHaveLength(0);
    expect(github.verifyUserInstallation).toHaveBeenCalledWith("42", expect.any(String));
  });

  it("rejects an app/user account mismatch before claiming ownership", async () => {
    const repository = new MemoryRepository();
    const github = fakeGithub();
    github.verifyUserInstallation = vi.fn(async () => ({
      id: "42",
      accountId: "10",
      accountLogin: "user-account",
      accountType: "Organization",
    }));
    github.verifyAppInstallation = vi.fn(async () => ({
      id: "42",
      accountId: "11",
      accountLogin: "app-account",
      accountType: "Organization",
    }));
    const service = new AuthService(
      repository,
      github,
      new CredentialCipher(Buffer.alloc(32)),
      config,
    );
    const session = await service.startInstallation("session-token");
    await expect(
      service.finishInstallation(
        { installation_id: "42", state: repository.lastState() },
        session.bindingCookieValue,
        "session-token",
      ),
    ).rejects.toThrow(/could not be verified/i);
    expect(repository.claims).toHaveLength(0);
  });
});

function fakeGithub(): GitHubAuthAdapter {
  return {
    exchangeUserCode: vi.fn(async () => ({ accessToken: "access" })),
    getAuthenticatedUser: vi.fn(async () => ({ id: "1", login: "octo" })),
    verifyUserInstallation: vi.fn(async (id) => ({
      id,
      accountId: "10",
      accountLogin: "octo",
      accountType: "Organization",
    })),
    verifyAppInstallation: vi.fn(async (id) => ({
      id,
      accountId: "10",
      accountLogin: "octo",
      accountType: "Organization",
    })),
    createAppJwt: vi.fn(() => "jwt"),
  };
}

class MemoryRepository implements AuthRepository {
  private states = new Map<
    string,
    {
      binding: string;
      flow: "SIGN_IN" | "INSTALL";
      userId?: string;
      encryptedPkceVerifier: string;
      expiresAt: Date;
      consumed: boolean;
    }
  >();
  consumed = false;
  credential?: Awaited<ReturnType<MemoryRepository["getCredential"]>>;
  sessionToken?: string;
  claims: Array<{ githubInstallationId: string; ownerId: string }> = [];

  lastState(): string {
    const state = [...this.states.keys()].at(-1);
    if (!state) throw new Error("No OAuth state");
    return state;
  }

  async createOAuthState(input: Parameters<AuthRepository["createOAuthState"]>[0]): Promise<void> {
    this.states.set(input.state, { ...input, consumed: false });
  }

  async consumeOAuthState(state: string, binding: string) {
    const value = this.states.get(state);
    if (!value || value.consumed || value.binding !== binding || value.expiresAt <= new Date())
      return null;
    value.consumed = true;
    this.consumed = true;
    return {
      id: "state-id",
      flow: value.flow,
      encryptedPkceVerifier: value.encryptedPkceVerifier,
      userId: value.userId ?? null,
      installationId: null,
      expiresAt: value.expiresAt,
    };
  }

  async upsertUserWithCredential(
    user: Parameters<AuthRepository["upsertUserWithCredential"]>[0],
    credential: Parameters<AuthRepository["upsertUserWithCredential"]>[1],
  ) {
    this.credential = { userId: "user-id", ...credential };
    return { id: "user-id", ...user };
  }

  async createSession(input: Parameters<AuthRepository["createSession"]>[0]): Promise<void> {
    this.sessionToken = input.token;
  }

  async findSession() {
    return {
      sessionId: "session-id",
      userId: "user-id",
      githubUserId: "1",
      githubLogin: "octo",
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  async revokeSession(): Promise<void> {}

  async getCredential() {
    return (
      this.credential ?? {
        userId: "user-id",
        encryptedAccessToken: new CredentialCipher(Buffer.alloc(32)).encrypt("access"),
        scopes: [],
      }
    );
  }

  async claimInstallation(input: Parameters<AuthRepository["claimInstallation"]>[0]) {
    this.claims.push(input);
    return {
      id: "installation-id",
      githubInstallationId: input.githubInstallationId,
      githubAccountId: null,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      ownerId: input.ownerId,
    };
  }
}
