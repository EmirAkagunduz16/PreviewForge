import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthInstallationRepository,
  InstallationIdentityConflictError,
  InstallationOwnershipConflictError,
} from "../src/auth-installation-repository.js";
import { createPrismaClient, type PrismaClient } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

describe("AuthInstallationRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let repository: AuthInstallationRepository;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    repository = new AuthInstallationRepository(prisma);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) return;
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("rejects wrong binding and expired state without consuming, then consumes once", async () => {
    const state = randomOpaque();
    const binding = randomOpaque();
    await repository.createOAuthState({
      state,
      binding,
      encryptedPkceVerifier: "v1.ciphertext",
      flow: "SIGN_IN",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(repository.consumeOAuthState(state, "wrong-binding")).resolves.toBeNull();
    const consumed = await repository.consumeOAuthState(state, binding);
    expect(consumed).toMatchObject({ flow: "SIGN_IN", encryptedPkceVerifier: "v1.ciphertext" });
    await expect(repository.consumeOAuthState(state, binding)).resolves.toBeNull();

    const expiredState = randomOpaque();
    const expiresAt = new Date(Date.now() + 60_000);
    await repository.createOAuthState({
      state: expiredState,
      binding,
      encryptedPkceVerifier: "v1.expired",
      flow: "SIGN_IN",
      expiresAt,
    });
    await expect(
      repository.consumeOAuthState(expiredState, binding, new Date(expiresAt.getTime() + 1)),
    ).resolves.toBeNull();
  });

  it("atomically consumes a state under concurrent callbacks", async () => {
    const state = randomOpaque();
    const binding = randomOpaque();
    await repository.createOAuthState({
      state,
      binding,
      encryptedPkceVerifier: "v1.concurrent",
      flow: "INSTALL",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => repository.consumeOAuthState(state, binding)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(11);
  });

  it("stores credentials as ciphertext and preserves immutable numeric identity", async () => {
    const githubUserId = uniqueNumericId();
    const user = await repository.upsertUserWithCredential(
      { githubUserId, githubLogin: `repo-${randomUUID()}` },
      {
        encryptedAccessToken: "v1.encrypted-access-token",
        encryptedRefreshToken: "v1.encrypted-refresh-token",
        scopes: ["read:user"],
      },
    );
    userIds.push(user.id);

    const stored = await prisma.gitHubCredential.findUnique({ where: { userId: user.id } });
    expect(stored?.encryptedAccessToken).toBe("v1.encrypted-access-token");
    expect(JSON.stringify(stored)).not.toContain("plaintext-access-token");
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.githubNumericId).toBe(
      BigInt(githubUserId),
    );

    const installationId = uniqueNumericId();
    const first = await repository.claimInstallation({
      githubInstallationId: installationId,
      githubAccountId: uniqueNumericId(),
      accountLogin: "previewforge-owner",
      accountType: "Organization",
      ownerId: user.id,
    });
    const repeated = await repository.claimInstallation({
      githubInstallationId: installationId,
      githubAccountId: first.githubAccountId ?? undefined,
      accountLogin: first.accountLogin,
      accountType: "Organization",
      ownerId: user.id,
    });
    expect(repeated.id).toBe(first.id);
    const beforeIdentityConflict = await repository.findInstallation(installationId);
    await expect(repository.listInstallations(user.id)).resolves.toEqual([beforeIdentityConflict]);
    await expect(repository.listInstallations(randomUUID())).resolves.toEqual([]);
    await expect(
      repository.claimInstallation({
        githubInstallationId: installationId,
        githubAccountId: uniqueNumericId(),
        accountLogin: "same-owner-different-account",
        accountType: "Organization",
        ownerId: user.id,
      }),
    ).rejects.toBeInstanceOf(InstallationIdentityConflictError);
    await expect(repository.findInstallation(installationId)).resolves.toEqual(
      beforeIdentityConflict,
    );
    await expect(
      repository.claimInstallation({
        githubInstallationId: installationId,
        accountLogin: "attacker",
        accountType: "User",
        ownerId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(InstallationOwnershipConflictError);
  });

  it("persists only a one-way session hash and rejects revoked/expired sessions", async () => {
    const githubUserId = uniqueNumericId();
    const user = await repository.upsertUserWithCredential(
      { githubUserId, githubLogin: `session-${randomUUID()}` },
      { encryptedAccessToken: "v1.session-access", scopes: [] },
    );
    userIds.push(user.id);
    const token = randomOpaque();
    await repository.createSession({
      token,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const stored = await prisma.session.findFirst({ where: { userId: user.id } });
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(repository.findSession(token)).resolves.toMatchObject({ userId: user.id });
    await repository.revokeSession(token);
    await expect(repository.findSession(token)).resolves.toBeNull();
  });

  it("keeps concurrent first claims idempotent for one owner", async () => {
    const githubUserId = uniqueNumericId();
    const user = await repository.upsertUserWithCredential(
      { githubUserId, githubLogin: `concurrent-${randomUUID()}` },
      { encryptedAccessToken: "v1.access", scopes: [] },
    );
    userIds.push(user.id);
    const githubInstallationId = uniqueNumericId();
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.claimInstallation({
          githubInstallationId,
          accountLogin: "same-owner",
          accountType: "User",
          ownerId: user.id,
        }),
      ),
    );
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(1);
    expect(
      await prisma.installation.count({
        where: { githubInstallationId: BigInt(githubInstallationId) },
      }),
    ).toBe(1);
  });
});

function randomOpaque(): string {
  return randomBytes(32).toString("base64url");
}

function uniqueNumericId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}
