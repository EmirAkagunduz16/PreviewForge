import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

export type OAuthStateFlow = "SIGN_IN" | "INSTALL";

export type OAuthStateInput = {
  state: string;
  binding: string;
  encryptedPkceVerifier: string;
  flow: OAuthStateFlow;
  userId?: string;
  installationId?: string;
  expiresAt: Date;
};

export type ConsumedOAuthState = {
  id: string;
  flow: OAuthStateFlow;
  encryptedPkceVerifier: string;
  userId: string | null;
  installationId: string | null;
  expiresAt: Date;
};

export type SessionInput = {
  token: string;
  userId: string;
  expiresAt: Date;
};

export type AuthUserInput = {
  githubUserId: string;
  githubLogin: string;
};

export type GitHubCredentialInput = {
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  tokenType?: string;
  scopes: string[];
};

export type AuthUserRecord = {
  id: string;
  githubUserId: string;
  githubLogin: string;
};

export type SessionRecord = AuthUserRecord & {
  sessionId: string;
  userId: string;
  expiresAt: Date;
};

export type GitHubCredentialRecord = GitHubCredentialInput & {
  userId: string;
};

export type InstallationClaimInput = {
  githubInstallationId: string;
  githubAccountId?: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  ownerId: string;
};

export type InstallationRecord = {
  id: string;
  githubInstallationId: string;
  githubAccountId: string | null;
  accountLogin: string;
  accountType: string;
  ownerId: string;
};

export class InstallationOwnershipConflictError extends Error {
  override readonly name = "InstallationOwnershipConflictError";

  constructor() {
    super("GitHub installation is already owned by another user");
  }
}

export class InstallationIdentityConflictError extends Error {
  override readonly name = "InstallationIdentityConflictError";

  constructor() {
    super("GitHub installation account identity cannot change");
  }
}

/** PostgreSQL-backed auth state, session, credential, and installation operations. */
export class AuthInstallationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createOAuthState(input: OAuthStateInput): Promise<void> {
    await this.prisma.oAuthState.create({
      data: {
        stateHash: hashOpaqueValue(input.state),
        bindingHash: hashOpaqueValue(input.binding),
        encryptedPkceVerifier: input.encryptedPkceVerifier,
        flow: input.flow,
        expiresAt: input.expiresAt,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.installationId ? { installationId: input.installationId } : {}),
      },
    });
  }

  /** Atomically consumes a state. A wrong binding, expired, or replayed state returns null. */
  async consumeOAuthState(
    state: string,
    binding: string,
    now = new Date(),
  ): Promise<ConsumedOAuthState | null> {
    const stateHash = hashOpaqueValue(state);
    const bindingHash = hashOpaqueValue(binding);
    return this.prisma.$transaction(async (tx) => {
      const consumed = await tx.oAuthState.updateMany({
        where: {
          stateHash,
          bindingHash,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return null;
      const row = await tx.oAuthState.findUnique({ where: { stateHash } });
      if (!row) return null;
      return {
        id: row.id,
        flow: row.flow as OAuthStateFlow,
        encryptedPkceVerifier: row.encryptedPkceVerifier,
        userId: row.userId,
        installationId: row.installationId,
        expiresAt: row.expiresAt,
      };
    });
  }

  async upsertUserWithCredential(
    user: AuthUserInput,
    credential: GitHubCredentialInput,
  ): Promise<AuthUserRecord> {
    const githubNumericId = parseGitHubId(user.githubUserId);
    return this.prisma.$transaction(async (tx) => {
      let saved = await tx.user.findUnique({ where: { githubNumericId } });
      if (saved) {
        saved = await tx.user.update({
          where: { id: saved.id },
          data: { githubLogin: user.githubLogin },
        });
      } else {
        // M1 rows may have the legacy text identity but no numeric projection.
        // Backfill only when the immutable text identity matches; never attach
        // a new numeric identity to an unrelated user.
        const legacy = await tx.user.findUnique({ where: { githubUserId: user.githubUserId } });
        if (legacy && legacy.githubNumericId === null) {
          saved = await tx.user.update({
            where: { id: legacy.id },
            data: { githubNumericId, githubLogin: user.githubLogin },
          });
        } else if (legacy) {
          if (legacy.githubNumericId !== githubNumericId) {
            throw new Error("GitHub user identity conflict");
          }
          saved = await tx.user.update({
            where: { id: legacy.id },
            data: { githubLogin: user.githubLogin },
          });
        } else {
          saved = await tx.user.create({
            data: {
              githubUserId: user.githubUserId,
              githubNumericId,
              githubLogin: user.githubLogin,
            },
          });
        }
      }
      await tx.gitHubCredential.upsert({
        where: { userId: saved.id },
        create: {
          userId: saved.id,
          encryptedAccessToken: credential.encryptedAccessToken,
          encryptedRefreshToken: credential.encryptedRefreshToken ?? null,
          accessTokenExpiresAt: credential.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: credential.refreshTokenExpiresAt ?? null,
          tokenType: credential.tokenType ?? null,
          scopes: credential.scopes,
        },
        update: {
          encryptedAccessToken: credential.encryptedAccessToken,
          encryptedRefreshToken: credential.encryptedRefreshToken ?? null,
          accessTokenExpiresAt: credential.accessTokenExpiresAt ?? null,
          refreshTokenExpiresAt: credential.refreshTokenExpiresAt ?? null,
          tokenType: credential.tokenType ?? null,
          scopes: credential.scopes,
        },
      });
      return toAuthUser(saved);
    });
  }

  async createSession(input: SessionInput): Promise<void> {
    await this.prisma.session.create({
      data: {
        tokenHash: hashOpaqueValue(input.token),
        userId: input.userId,
        expiresAt: input.expiresAt,
      },
    });
  }

  async findSession(token: string, now = new Date()): Promise<SessionRecord | null> {
    const row = await this.prisma.session.findFirst({
      where: {
        tokenHash: hashOpaqueValue(token),
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { user: true },
    });
    if (!row) return null;
    return {
      sessionId: row.id,
      userId: row.userId,
      expiresAt: row.expiresAt,
      ...toAuthUser(row.user),
    };
  }

  async revokeSession(token: string, now = new Date()): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: hashOpaqueValue(token), revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async getCredential(userId: string): Promise<GitHubCredentialRecord | null> {
    const row = await this.prisma.gitHubCredential.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      userId: row.userId,
      encryptedAccessToken: row.encryptedAccessToken,
      scopes: row.scopes,
      ...(row.encryptedRefreshToken ? { encryptedRefreshToken: row.encryptedRefreshToken } : {}),
      ...(row.accessTokenExpiresAt ? { accessTokenExpiresAt: row.accessTokenExpiresAt } : {}),
      ...(row.refreshTokenExpiresAt ? { refreshTokenExpiresAt: row.refreshTokenExpiresAt } : {}),
      ...(row.tokenType ? { tokenType: row.tokenType } : {}),
    };
  }

  /** Idempotently claims an installation, but never permits ownership transfer. */
  async claimInstallation(input: InstallationClaimInput): Promise<InstallationRecord> {
    const data: Prisma.InstallationUncheckedCreateInput = {
      githubInstallationId: parseGitHubId(input.githubInstallationId),
      githubAccountId:
        input.githubAccountId === undefined ? null : parseGitHubId(input.githubAccountId),
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      ownerId: input.ownerId,
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.installation.findUnique({
          where: { githubInstallationId: data.githubInstallationId },
        });
        if (existing) {
          if (existing.ownerId !== input.ownerId) throw new InstallationOwnershipConflictError();
          if (
            existing.githubAccountId !== null &&
            data.githubAccountId !== null &&
            existing.githubAccountId !== data.githubAccountId
          ) {
            throw new InstallationIdentityConflictError();
          }
          const updated = await tx.installation.update({
            where: { id: existing.id },
            data: {
              ...(data.githubAccountId === null ? {} : { githubAccountId: data.githubAccountId }),
              accountLogin: data.accountLogin,
              accountType: data.accountType,
            },
          });
          return toInstallation(updated);
        }
        const created = await tx.installation.create({ data });
        return toInstallation(created);
      });
    } catch (error) {
      // A concurrent first claim can win between findUnique and create. Re-read
      // after the unique conflict and apply the same immutable-owner rule.
      if (
        error instanceof InstallationOwnershipConflictError ||
        error instanceof InstallationIdentityConflictError
      ) {
        throw error;
      }
      if (!isInstallationIdUniqueViolation(error)) throw error;
      const existing = await this.prisma.installation.findUnique({
        where: { githubInstallationId: data.githubInstallationId },
      });
      if (!existing) throw error;
      if (existing.ownerId !== input.ownerId) throw new InstallationOwnershipConflictError();
      if (
        existing.githubAccountId !== null &&
        data.githubAccountId !== null &&
        existing.githubAccountId !== data.githubAccountId
      ) {
        throw new InstallationIdentityConflictError();
      }
      return toInstallation(existing);
    }
  }

  async findInstallation(githubInstallationId: string): Promise<InstallationRecord | null> {
    const row = await this.prisma.installation.findUnique({
      where: { githubInstallationId: parseGitHubId(githubInstallationId) },
    });
    return row ? toInstallation(row) : null;
  }
}

export function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isInstallationIdUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        cause?: { constraint?: { index?: unknown } };
      };
    };
  };
  if (candidate.code !== "P2002") return false;
  const target = candidate.meta?.target;
  if (Array.isArray(target)) return target.includes("github_installation_id");
  if (typeof target === "string" && target.includes("github_installation_id")) return true;
  const index = candidate.meta?.driverAdapterError?.cause?.constraint?.index;
  return typeof index === "string" && index.includes("github_installation_id");
}

function parseGitHubId(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("GitHub ID must be a positive decimal string");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n)
    throw new Error("GitHub ID exceeds PostgreSQL BIGINT range");
  return parsed;
}

function toAuthUser(row: {
  id: string;
  githubUserId: string;
  githubLogin: string;
}): AuthUserRecord {
  return { id: row.id, githubUserId: row.githubUserId, githubLogin: row.githubLogin };
}

function toInstallation(row: {
  id: string;
  githubInstallationId: bigint;
  githubAccountId: bigint | null;
  accountLogin: string;
  accountType: string;
  ownerId: string;
}): InstallationRecord {
  return {
    id: row.id,
    githubInstallationId: row.githubInstallationId.toString(),
    githubAccountId: row.githubAccountId?.toString() ?? null,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    ownerId: row.ownerId,
  };
}
