import type {
  AuthInstallationRepository,
  AuthUserRecord,
  InstallationClaimInput,
  InstallationRecord,
  OAuthStateFlow,
  SessionRecord,
} from "@previewforge/database";

export type AuthRuntimeConfig = {
  clientId: string;
  appSlug: string;
  oauthBaseUrl?: string;
  publicBaseUrl: string;
  sessionTtlSeconds: number;
  oauthStateTtlSeconds: number;
};

export type GitHubAuthAdapter = {
  exchangeUserCode(input: { code: string; redirectUri?: string; codeVerifier?: string }): Promise<{
    accessToken: string;
    tokenType?: string;
    scope?: string;
    expiresIn?: number;
    refreshToken?: string;
    refreshTokenExpiresIn?: number;
  }>;
  getAuthenticatedUser(userToken: string): Promise<{ id: string; login: string }>;
  verifyUserInstallation(
    installationId: string,
    userToken: string,
  ): Promise<{
    id: string;
    accountLogin?: string;
    accountId?: string;
    accountType?: string;
  }>;
  verifyAppInstallation(
    installationId: string,
    appJwt?: string,
  ): Promise<{
    id: string;
    accountLogin?: string;
    accountId?: string;
    accountType?: string;
  }>;
  createAppJwt(): string;
};

export type CredentialCipherLike = {
  encrypt(value: string, associatedData?: string): string;
  decrypt(value: string, associatedData?: string): string;
};

export type AuthRepository = Pick<
  AuthInstallationRepository,
  | "createOAuthState"
  | "consumeOAuthState"
  | "upsertUserWithCredential"
  | "createSession"
  | "findSession"
  | "revokeSession"
  | "getCredential"
  | "claimInstallation"
>;

export type { AuthUserRecord, InstallationRecord };

export type InstallationClaim = InstallationClaimInput;
export type { OAuthStateFlow, SessionRecord };
