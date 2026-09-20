import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { githubOAuthCallbackSchema } from "@previewforge/contracts";
import { bindingCookieOptions, serializeCookie } from "../security/cookies.js";
import { AuthFlowError } from "./auth.errors.js";
import type {
  AuthRepository,
  AuthRuntimeConfig,
  AuthUserRecord,
  CredentialCipherLike,
  GitHubAuthAdapter,
  InstallationRecord,
  SessionRecord,
} from "./auth.types.js";

export const OAUTH_BINDING_COOKIE = "previewforge_oauth_binding";
export const SESSION_COOKIE = "previewforge_session";

export type OAuthStart = {
  authorizationUrl: string;
  bindingCookieValue: string;
};

export type AuthSessionResult = {
  user: AuthUserRecord;
  sessionToken: string;
  sessionExpiresAt: Date;
};

const PKCE_VERIFIER_BYTES = 32;
const API_PREFIX = "/api";

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly github: GitHubAuthAdapter,
    private readonly cipher: CredentialCipherLike,
    private readonly config: AuthRuntimeConfig,
  ) {}

  async startSignIn(): Promise<OAuthStart> {
    const state = randomOpaqueValue();
    const binding = randomOpaqueValue();
    const verifier = randomOpaqueValue(PKCE_VERIFIER_BYTES);
    await this.repository.createOAuthState({
      state,
      binding,
      encryptedPkceVerifier: this.cipher.encrypt(verifier),
      flow: "SIGN_IN",
      expiresAt: new Date(Date.now() + this.config.oauthStateTtlSeconds * 1000),
    });

    const authorization = new URL(
      "/login/oauth/authorize",
      this.config.oauthBaseUrl ?? "https://github.com",
    );
    authorization.searchParams.set("client_id", this.config.clientId);
    authorization.searchParams.set("redirect_uri", this.callbackUrl("/auth/github/callback"));
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", codeChallenge(verifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: authorization.toString(), bindingCookieValue: binding };
  }

  async finishSignIn(query: unknown, binding: string | undefined): Promise<AuthSessionResult> {
    const callback = githubOAuthCallbackSchema.safeParse(query);
    if (!callback.success || !binding) throw new UnauthorizedException("Invalid OAuth callback");
    const consumed = await this.repository.consumeOAuthState(callback.data.state, binding);
    if (!consumed) {
      throw new UnauthorizedException("Invalid or expired OAuth state");
    }
    if (consumed.flow !== "SIGN_IN") {
      throw new UnauthorizedException("Invalid or expired OAuth state");
    }

    let verifier: string;
    try {
      verifier = this.cipher.decrypt(consumed.encryptedPkceVerifier);
    } catch {
      throw new UnauthorizedException("Invalid OAuth state");
    }

    let token: Awaited<ReturnType<GitHubAuthAdapter["exchangeUserCode"]>>;
    try {
      token = await this.github.exchangeUserCode({
        code: callback.data.code,
        redirectUri: this.callbackUrl("/auth/github/callback"),
        codeVerifier: verifier,
      });
      const githubUser = await this.github.getAuthenticatedUser(token.accessToken);
      const accessTokenExpiresAt = token.expiresIn
        ? new Date(Date.now() + token.expiresIn * 1000)
        : undefined;
      const refreshTokenExpiresAt = token.refreshTokenExpiresIn
        ? new Date(Date.now() + token.refreshTokenExpiresIn * 1000)
        : undefined;
      const credential = {
        encryptedAccessToken: this.cipher.encrypt(token.accessToken),
        scopes: parseScopes(token.scope),
        ...(token.refreshToken
          ? { encryptedRefreshToken: this.cipher.encrypt(token.refreshToken) }
          : {}),
        ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
        ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
        ...(token.tokenType ? { tokenType: token.tokenType } : {}),
      };
      const user = await this.repository.upsertUserWithCredential(
        { githubUserId: githubUser.id, githubLogin: githubUser.login },
        credential,
      );
      return this.createSession(user);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new AuthFlowError("GitHub sign-in could not be completed", error);
    }
  }

  async authenticate(sessionToken: string | undefined): Promise<SessionRecord> {
    if (!sessionToken) throw new UnauthorizedException("Authentication required");
    const session = await this.repository.findSession(sessionToken);
    if (!session) throw new UnauthorizedException("Authentication required");
    return session;
  }

  async revoke(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) await this.repository.revokeSession(sessionToken);
  }

  oauthBindingCookie(value: string, maxAge = this.config.oauthStateTtlSeconds): string {
    return serializeCookie(
      OAUTH_BINDING_COOKIE,
      value,
      bindingCookieOptions(maxAge, this.config.publicBaseUrl),
    );
  }

  sessionCookie(value: string, expiresAt: Date): string {
    return serializeCookie(
      SESSION_COOKIE,
      value,
      bindingCookieOptions(
        Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
        this.config.publicBaseUrl,
      ),
    );
  }

  clearCookie(name: string): string {
    return serializeCookie(name, "", bindingCookieOptions(0, this.config.publicBaseUrl));
  }

  async startInstallation(sessionToken: string | undefined): Promise<OAuthStart> {
    const session = await this.authenticate(sessionToken);
    const state = randomOpaqueValue();
    const binding = randomOpaqueValue();
    const verifier = randomOpaqueValue(PKCE_VERIFIER_BYTES);
    await this.repository.createOAuthState({
      state,
      binding,
      encryptedPkceVerifier: this.cipher.encrypt(verifier),
      flow: "INSTALL",
      userId: session.userId,
      expiresAt: new Date(Date.now() + this.config.oauthStateTtlSeconds * 1000),
    });
    // Setup URLs carry state through GitHub and return it to the configured
    // callback. PKCE is retained in the durable state for callback binding;
    // GitHub's installation setup endpoint does not exchange an OAuth code.
    const setup = new URL(
      `/apps/${encodeURIComponent(this.config.appSlug)}/installations/new`,
      this.config.oauthBaseUrl ?? "https://github.com",
    );
    setup.searchParams.set("state", state);
    setup.searchParams.set("redirect_uri", this.callbackUrl("/installations/github/callback"));
    return { authorizationUrl: setup.toString(), bindingCookieValue: binding };
  }

  async listInstallations(sessionToken: string | undefined): Promise<InstallationRecord[]> {
    const session = await this.authenticate(sessionToken);
    return this.repository.listInstallations(session.userId);
  }

  async finishInstallation(
    query: unknown,
    binding: string | undefined,
    sessionToken: string | undefined,
  ): Promise<InstallationRecord> {
    const session = await this.authenticate(sessionToken);
    const parsed = parseInstallationCallback(query);
    if (!binding) throw new UnauthorizedException("Invalid installation callback");
    const consumed = await this.repository.consumeOAuthState(parsed.state, binding);
    if (!consumed) {
      throw new UnauthorizedException("Invalid or expired installation state");
    }
    if (consumed.flow !== "INSTALL" || consumed.userId !== session.userId) {
      throw new UnauthorizedException("Invalid or expired installation state");
    }

    const credential = await this.repository.getCredential(session.userId);
    if (!credential) throw new UnauthorizedException("GitHub sign-in required");
    let accessToken: string;
    try {
      accessToken = this.cipher.decrypt(credential.encryptedAccessToken);
    } catch {
      throw new UnauthorizedException("GitHub sign-in required");
    }

    try {
      const [userInstallation, appInstallation] = await Promise.all([
        this.github.verifyUserInstallation(parsed.installationId, accessToken),
        this.github.verifyAppInstallation(parsed.installationId),
      ]);
      if (
        userInstallation.id !== parsed.installationId ||
        appInstallation.id !== parsed.installationId
      ) {
        throw new UnauthorizedException("Installation could not be verified");
      }
      if (
        userInstallation.accountId &&
        appInstallation.accountId &&
        userInstallation.accountId !== appInstallation.accountId
      ) {
        throw new UnauthorizedException("Installation could not be verified");
      }
      const accountLogin = userInstallation.accountLogin ?? appInstallation.accountLogin;
      const accountType = userInstallation.accountType ?? appInstallation.accountType;
      if (!accountLogin || (accountType !== "User" && accountType !== "Organization")) {
        throw new UnauthorizedException("Installation could not be verified");
      }
      const accountId = userInstallation.accountId ?? appInstallation.accountId;
      return await this.repository.claimInstallation({
        githubInstallationId: parsed.installationId,
        accountLogin,
        accountType,
        ownerId: session.userId,
        ...(accountId ? { githubAccountId: accountId } : {}),
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("Installation could not be verified");
    }
  }

  private async createSession(user: AuthUserRecord): Promise<AuthSessionResult> {
    const sessionToken = randomOpaqueValue();
    const sessionExpiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
    await this.repository.createSession({
      token: sessionToken,
      userId: user.id,
      expiresAt: sessionExpiresAt,
    });
    return { user, sessionToken, sessionExpiresAt };
  }

  private callbackUrl(path: string): string {
    return new URL(`${API_PREFIX}${path}`, `${this.config.publicBaseUrl}/`).toString();
  }
}

function randomOpaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function parseScopes(scope: string | undefined): string[] {
  return scope
    ? scope
        .split(/[ ,]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

function parseInstallationCallback(value: unknown): { installationId: string; state: string } {
  if (!value || typeof value !== "object")
    throw new BadRequestException("Invalid installation callback");
  const source = value as Record<string, unknown>;
  const installationId = source.installation_id;
  const state = source.state;
  if (
    typeof installationId !== "string" ||
    !/^[1-9][0-9]*$/.test(installationId) ||
    typeof state !== "string" ||
    state.length < 1 ||
    state.length > 2048
  ) {
    throw new BadRequestException("Invalid installation callback");
  }
  return { installationId, state };
}
