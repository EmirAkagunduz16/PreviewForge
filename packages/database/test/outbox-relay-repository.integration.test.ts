import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../src/index.js";
import {
  OutboxClaimLostError,
  OutboxRelayRepository,
  OutboxRelayValidationError,
} from "../src/outbox-relay-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

describe("OutboxRelayRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await prisma.outboxEvent.deleteMany({ where: { id: { in: fixture.outboxIds } } });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await prisma.$disconnect();
  });

  it("claims rows concurrently once in stable created-at order and respects bounds", async () => {
    const fixture = await createFixture(prisma, 6);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);

    const owners = ["relay-a", "relay-b", "relay-c"] as const;
    const batches = await Promise.all(
      owners.map((owner) => repository.claimBatch({ owner, limit: 2, leaseDurationMs: 10_000 })),
    );
    const claimed = batches.flat();
    const claimedIds = claimed.map((row) => row.id);
    const expectedOrder = new Map(fixture.outboxIds.map((id, index) => [id, index]));

    expect(claimed).toHaveLength(fixture.outboxIds.length);
    expect(new Set(claimedIds).size).toBe(fixture.outboxIds.length);
    expect([...claimedIds].sort()).toEqual([...fixture.outboxIds].sort());
    for (const batch of batches) {
      expect(batch).toHaveLength(2);
      expect(batch.every((row) => row.claimToken && row.claimOwner)).toBe(true);
      expect(batch.map((row) => expectedOrder.get(row.id))).toEqual(
        [...batch]
          .map((row) => expectedOrder.get(row.id))
          .sort((left, right) => (left ?? 0) - (right ?? 0)),
      );
    }

    const durableRows = await prisma.outboxEvent.findMany({
      where: { id: { in: fixture.outboxIds } },
      select: { id: true, claimOwner: true, claimToken: true, claimExpiresAt: true },
    });
    const returnedById = new Map(claimed.map((row) => [row.id, row]));
    for (const row of durableRows) {
      const returned = returnedById.get(row.id);
      expect(returned).toBeDefined();
      expect(row).toMatchObject({
        claimOwner: returned?.claimOwner,
        claimToken: returned?.claimToken,
        claimExpiresAt: expect.any(Date),
      });
    }
    expect(new Set(durableRows.map((row) => row.claimToken)).size).toBe(fixture.outboxIds.length);
    expect(batches.map((batch) => batch.map((row) => row.claimOwner))).toEqual(
      owners.map((owner, index) => batches[index]?.map(() => owner)),
    );
  });

  it("reserves the attempt at claim time and keeps it unchanged on successful settlement", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);
    const claimed = (
      await repository.claimBatch({ owner: "relay-reserve", leaseDurationMs: 10_000 })
    )[0];
    if (!claimed?.claimToken) throw new Error("reservation claim was not returned");
    expect(claimed.attempts).toBe(1);
    expect(claimed.lastAttemptAt).toEqual(expect.any(Date));
    const published = await repository.markPublished(claimed.id, claimed.claimToken);
    expect(published.outcome).toBe("PUBLISHED");
    expect(published.outbox.attempts).toBe(1);
  });

  it("takes over an expired claim with a new token and owner", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);

    const first = await repository.claimBatch({ owner: "relay-old", leaseDurationMs: 25 });
    const oldClaim = first[0];
    if (!oldClaim?.claimToken) throw new Error("initial claim was not returned");
    await waitForLeaseExpiry(prisma, firstOutboxId(fixture));

    const second = await repository.claimBatch({ owner: "relay-new", leaseDurationMs: 10_000 });
    const newClaim = second[0];
    expect(newClaim).toMatchObject({ id: fixture.outboxIds[0], claimOwner: "relay-new" });
    expect(newClaim?.claimToken).not.toBe(oldClaim.claimToken);
  });

  it("rejects stale settlement after takeover and accepts only the current token", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);

    const first = await repository.claimBatch({ owner: "relay-old", leaseDurationMs: 25 });
    const oldClaim = first[0];
    if (!oldClaim?.claimToken) throw new Error("initial claim was not returned");
    await waitForLeaseExpiry(prisma, firstOutboxId(fixture));
    const second = await repository.claimBatch({ owner: "relay-new", leaseDurationMs: 10_000 });
    const newClaim = second[0];
    if (!newClaim?.claimToken) throw new Error("takeover claim was not returned");
    const outboxId = firstOutboxId(fixture);

    await expect(repository.markPublished(outboxId, oldClaim.claimToken)).rejects.toBeInstanceOf(
      OutboxClaimLostError,
    );
    const published = await repository.markPublished(outboxId, newClaim.claimToken);
    expect(published.outcome).toBe("PUBLISHED");
    expect(published.outbox).toMatchObject({
      attempts: 2,
      publishedAt: expect.any(Date),
      lastAttemptAt: expect.any(Date),
      claimToken: null,
    });
    expect(await prisma.outboxEvent.count({ where: { id: outboxId } })).toBe(1);
  });

  it("leaves an acknowledged-but-unmarked publish reclaimable after relay crash", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);

    const first = await repository.claimBatch({ owner: "relay-crashed", leaseDurationMs: 25 });
    expect(first).toHaveLength(1);
    expect(first[0]?.attempts).toBe(1);
    await waitForLeaseExpiry(prisma, firstOutboxId(fixture));

    const reclaimed = await repository.claimBatch({
      owner: "relay-restarted",
      leaseDurationMs: 10_000,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.publishedAt).toBeNull();
    expect(reclaimed[0]?.attempts).toBe(2);
    if (!reclaimed[0]?.claimToken) throw new Error("reclaimed row has no claim token");
    const outboxId = firstOutboxId(fixture);
    await repository.markPublished(outboxId, reclaimed[0].claimToken);
    const row = await prisma.outboxEvent.findUnique({ where: { id: outboxId } });
    expect(row).toMatchObject({
      attempts: 2,
      publishedAt: expect.any(Date),
      lastAttemptAt: expect.any(Date),
      claimToken: null,
      claimOwner: null,
    });
  });

  it("records a redacted retry and does not claim before its server-time schedule", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);
    const claim = (
      await repository.claimBatch({ owner: "relay-retry", leaseDurationMs: 10_000 })
    )[0];
    if (!claim?.claimToken) throw new Error("retry fixture was not claimed");
    const outboxId = firstOutboxId(fixture);

    const failure = await repository.recordFailure({
      id: outboxId,
      claimToken: claim.claimToken,
      failure: {
        code: "BROKER_UNAVAILABLE",
        message: "send failed with ghp_super-secret-token",
        retryable: true,
      },
      retryDelayMs: 200,
    });
    expect(failure.outcome).toBe("RETRY_SCHEDULED");
    expect(failure.outbox).toMatchObject({ attempts: 1, claimToken: null, deadLetteredAt: null });
    expect(failure.outbox.lastError).toContain("[REDACTED]");
    expect(failure.outbox.lastError).not.toContain("ghp_super-secret-token");
    expect(await repository.claimBatch({ owner: "relay-too-early" })).toHaveLength(0);

    await waitForAvailability(prisma, outboxId);
    const rescheduled = await repository.claimBatch({
      owner: "relay-after-backoff",
      leaseDurationMs: 10_000,
    });
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0]?.attempts).toBe(2);
  });

  it("dead-letters nonretryable failures and never deletes the row", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);
    const claim = (
      await repository.claimBatch({ owner: "relay-poison", leaseDurationMs: 10_000 })
    )[0];
    if (!claim?.claimToken) throw new Error("dead-letter fixture was not claimed");
    const outboxId = firstOutboxId(fixture);

    const failure = await repository.recordFailure({
      id: outboxId,
      claimToken: claim.claimToken,
      failure: {
        code: "INVALID_EVENT",
        message: "payload contains token=do-not-persist",
        retryable: false,
      },
    });
    expect(failure.outcome).toBe("DEAD_LETTER");
    expect(failure.outbox).toMatchObject({
      attempts: 1,
      deadLetteredAt: expect.any(Date),
      claimToken: null,
    });
    expect(failure.outbox.deadLetterReason).toContain("INVALID_EVENT");
    expect(failure.outbox.deadLetterReason).not.toContain("do-not-persist");
    expect(await repository.claimBatch({ owner: "relay-after-dead-letter" })).toHaveLength(0);
    expect(await prisma.outboxEvent.count({ where: { id: outboxId } })).toBe(1);
  });

  it("dead-letters a retryable event after the bounded attempt budget", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);

    const first = (
      await repository.claimBatch({ owner: "relay-attempt-1", leaseDurationMs: 10_000 })
    )[0];
    if (!first?.claimToken) throw new Error("first attempt was not claimed");
    const outboxId = firstOutboxId(fixture);
    const scheduled = await repository.recordFailure({
      id: outboxId,
      claimToken: first.claimToken,
      failure: { code: "NETWORK_TIMEOUT", message: "temporary network timeout", retryable: true },
      maxAttempts: 2,
      retryDelayMs: 1,
    });
    expect(scheduled.outcome).toBe("RETRY_SCHEDULED");
    await waitForAvailability(prisma, outboxId);

    const second = (
      await repository.claimBatch({ owner: "relay-attempt-2", leaseDurationMs: 10_000 })
    )[0];
    if (!second?.claimToken) throw new Error("second attempt was not claimed");
    const exhausted = await repository.recordFailure({
      id: outboxId,
      claimToken: second.claimToken,
      failure: { code: "NETWORK_TIMEOUT", message: "temporary network timeout", retryable: true },
      maxAttempts: 2,
      retryDelayMs: 1,
    });
    expect(exhausted.outcome).toBe("DEAD_LETTER");
    expect(exhausted.outbox.attempts).toBe(2);
  });

  it("bounds repeated un-settled publish crashes and durably dead-letters at exhaustion", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const repository = new OutboxRelayRepository(prisma);
    const outboxId = firstOutboxId(fixture);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const claimed = (
        await repository.claimBatch({
          owner: `relay-crash-${attempt}`,
          leaseDurationMs: 25,
          maxAttempts,
        })
      )[0];
      expect(claimed).toMatchObject({ id: outboxId, attempts: attempt });
      await waitForLeaseExpiry(prisma, outboxId);
    }

    expect(
      await repository.claimBatch({ owner: "relay-after-exhaustion", maxAttempts }),
    ).toHaveLength(0);
    const exhausted = await prisma.outboxEvent.findUnique({ where: { id: outboxId } });
    expect(exhausted).toMatchObject({
      attempts: maxAttempts,
      deadLetteredAt: expect.any(Date),
      deadLetterReason: "MAX_ATTEMPTS_EXHAUSTED",
      claimToken: null,
      claimOwner: null,
      claimExpiresAt: null,
      publishedAt: null,
    });
  });

  it("rejects unsafe relay and failure inputs without echoing secret text", async () => {
    const repository = new OutboxRelayRepository(prisma);
    await expect(repository.claimBatch({ owner: " " })).rejects.toBeInstanceOf(
      OutboxRelayValidationError,
    );
    await expect(
      repository.recordFailure({
        id: randomUUID(),
        claimToken: randomUUID(),
        failure: { code: "bad-code", message: "x", retryable: false },
      }),
    ).rejects.toBeInstanceOf(OutboxRelayValidationError);
  });
});

type Fixture = {
  userId: string;
  outboxIds: string[];
};

async function createFixture(prisma: PrismaClient, count = 1): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const commitSha = suffix.replaceAll("-", "").padEnd(40, "0").slice(0, 40);

  await prisma.user.create({
    data: { id: userId, githubUserId: `outbox-${suffix}`, githubLogin: `outbox-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000)),
      accountLogin: `outbox-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `outbox/${suffix}`,
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      previewKey: `outbox-${suffix}`,
      desiredCommitSha: commitSha,
    },
  });
  await prisma.deployment.create({ data: { id: deploymentId, environmentId, commitSha } });

  const outboxIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    outboxIds.push(id);
    await prisma.outboxEvent.create({
      data: {
        id,
        eventType: "deployment.requested.v1",
        aggregateType: "deployment",
        aggregateId: deploymentId,
        payload: { eventId: id, eventType: "deployment.requested.v1" },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      },
    });
  }
  return { userId, outboxIds };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForLeaseExpiry(prisma: PrismaClient, outboxId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.outboxEvent.findUnique({
      where: { id: outboxId },
      select: { claimExpiresAt: true },
    });
    const server = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    if (row?.claimExpiresAt && server[0] && server[0].now >= row.claimExpiresAt) return;
    await wait(10);
  }
  throw new Error("outbox claim did not expire within bounded test window");
}

async function waitForAvailability(prisma: PrismaClient, outboxId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.outboxEvent.findUnique({
      where: { id: outboxId },
      select: { availableAt: true },
    });
    const server = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    if (row?.availableAt && server[0] && server[0].now >= row.availableAt) return;
    await wait(10);
  }
  throw new Error("outbox retry did not become available within bounded test window");
}

function firstOutboxId(fixture: Fixture): string {
  const id = fixture.outboxIds[0];
  if (!id) throw new Error("fixture has no outbox event");
  return id;
}
