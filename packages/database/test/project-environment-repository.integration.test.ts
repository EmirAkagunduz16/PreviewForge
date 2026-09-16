import { randomUUID } from "node:crypto";
import { CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
  ProjectEnvironmentRepository,
} from "../src/index.js";
import { createDatabaseFixture } from "./fixtures.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for project environment integration tests");

describe("ProjectEnvironmentRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const fixtures: Array<{ userId: string; projectId: string }> = [];
  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });
  afterAll(async () => {
    if (fixtures.length)
      await prisma.user.deleteMany({ where: { id: { in: fixtures.map((f) => f.userId) } } });
    await prisma.$disconnect();
  });

  it("upserts encrypted project-shared values, scopes owners, binds AAD, and cascades", async () => {
    const first = await createDatabaseFixture(prisma);
    const second = await createDatabaseFixture(prisma);
    fixtures.push(first, second);
    const repository = new ProjectEnvironmentRepository(prisma);
    const cipher = new CredentialCipher(Buffer.alloc(32, 11));
    const value = "db-secret-value";
    const encrypted = cipher.encrypt(
      value,
      projectEnvironmentAssociatedData(first.projectId, "TOKEN"),
    );
    const inserted = await repository.upsert(first.userId, first.projectId, "TOKEN", encrypted);
    expect(inserted?.key).toBe("TOKEN");
    const replacedCiphertext = cipher.encrypt(
      "replaced",
      projectEnvironmentAssociatedData(first.projectId, "TOKEN"),
    );
    await repository.upsert(first.userId, first.projectId, "TOKEN", replacedCiphertext);
    const firstPullRequest = await prisma.pullRequest.create({
      data: {
        projectId: first.projectId,
        number: 41,
        title: "First shared preview",
        headSha: "b".repeat(40),
        state: "OPEN",
      },
    });
    const secondPullRequest = await prisma.pullRequest.create({
      data: {
        projectId: first.projectId,
        number: 42,
        title: "Second shared preview",
        headSha: "c".repeat(40),
        state: "CLOSED",
      },
    });
    await prisma.previewEnvironment.update({
      where: { id: first.environmentId },
      data: { pullRequestId: firstPullRequest.id },
    });
    const secondEnvironment = await prisma.previewEnvironment.create({
      data: {
        projectId: first.projectId,
        previewKey: `m6-shared-${randomUUID()}`,
        desiredCommitSha: secondPullRequest.headSha,
        pullRequestId: secondPullRequest.id,
      },
    });
    const previewContexts = await prisma.previewEnvironment.findMany({
      where: { projectId: first.projectId },
      select: {
        id: true,
        projectId: true,
        pullRequest: { select: { id: true, number: true, headSha: true, state: true } },
      },
      orderBy: { pullRequest: { number: "asc" } },
    });
    expect(previewContexts).toHaveLength(2);
    expect(new Set(previewContexts.map((context) => context.id)).size).toBe(2);
    expect(previewContexts).toEqual([
      {
        id: first.environmentId,
        projectId: first.projectId,
        pullRequest: {
          id: firstPullRequest.id,
          number: 41,
          headSha: "b".repeat(40),
          state: "OPEN",
        },
      },
      {
        id: secondEnvironment.id,
        projectId: first.projectId,
        pullRequest: {
          id: secondPullRequest.id,
          number: 42,
          headSha: "c".repeat(40),
          state: "CLOSED",
        },
      },
    ]);
    const valuesByPreviewContext = await Promise.all(
      previewContexts.map(async (context) => {
        expect(context.pullRequest).not.toBeNull();
        const rows = await repository.listEncryptedByProjectId(context.projectId);
        return Object.fromEntries(
          rows.map((row) => [
            row.key,
            cipher.decrypt(
              row.encryptedValue,
              projectEnvironmentAssociatedData(context.projectId, row.key),
            ),
          ]),
        );
      }),
    );
    expect(valuesByPreviewContext).toEqual([{ TOKEN: "replaced" }, { TOKEN: "replaced" }]);
    expect(await repository.listNames(first.userId, first.projectId)).toHaveLength(1);
    expect(await repository.listNames(second.userId, first.projectId)).toEqual([]);
    expect(await repository.listEncryptedByProjectId(second.projectId)).toEqual([]);
    const stored = await prisma.projectEnvironmentVariable.findUniqueOrThrow({
      where: { projectId_key: { projectId: first.projectId, key: "TOKEN" } },
    });
    expect(stored.encryptedValue).not.toContain(value);
    expect(
      cipher.decrypt(
        stored.encryptedValue,
        projectEnvironmentAssociatedData(first.projectId, "TOKEN"),
      ),
    ).toBe("replaced");
    expect(() =>
      cipher.decrypt(
        stored.encryptedValue,
        projectEnvironmentAssociatedData(second.projectId, "TOKEN"),
      ),
    ).toThrow();
    expect(await repository.delete(first.userId, first.projectId, "TOKEN")).toBe(true);
    await repository.upsert(first.userId, first.projectId, "TOKEN", encrypted);
    await prisma.user.delete({ where: { id: first.userId } });
    fixtures.splice(fixtures.indexOf(first), 1);
    expect(
      await prisma.projectEnvironmentVariable.count({ where: { projectId: first.projectId } }),
    ).toBe(0);
  });
});
