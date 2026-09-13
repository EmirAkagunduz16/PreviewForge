import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

describe("M3 Kafka dispatch migration (PostgreSQL)", () => {
  let prisma: PrismaClient;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await prisma.kafkaDelivery.deleteMany({ where: { id: { in: fixture.kafkaDeliveryIds } } });
      await prisma.consumerReceipt.deleteMany({ where: { id: { in: fixture.receiptIds } } });
      await prisma.outboxEvent.deleteMany({ where: { id: { in: fixture.outboxIds } } });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await prisma.$disconnect();
  });

  it("keeps existing M2 rows readable and preserves receipt semantic uniqueness", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    const deployment = await prisma.deployment.findUnique({
      where: { id: fixture.deploymentId },
      select: { id: true, status: true, commitSha: true, leaseGeneration: true },
    });
    expect(deployment).toEqual({
      id: fixture.deploymentId,
      status: "QUEUED",
      commitSha: fixture.commitSha,
      leaseGeneration: 0,
    });

    const outbox = await prisma.outboxEvent.create({
      data: {
        id: fixture.outboxId,
        eventType: "deployment.requested.v1",
        aggregateType: "deployment",
        aggregateId: fixture.deploymentId,
        payload: { eventId: fixture.outboxId },
      },
    });
    expect(outbox.publishedAt).toBeNull();
    expect(outbox.attempts).toBe(0);
    expect(outbox.claimToken).toBeNull();
    expect(outbox.deadLetteredAt).toBeNull();

    const receipt = await prisma.consumerReceipt.create({
      data: {
        id: fixture.receiptId,
        consumerName: "m3-migration-test",
        eventId: fixture.outboxId,
      },
    });
    expect(receipt.consumerName).toBe("m3-migration-test");
    await expect(
      prisma.consumerReceipt.create({
        data: {
          id: randomUUID(),
          consumerName: "m3-migration-test",
          eventId: fixture.outboxId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects invalid outbox claim, retry, and settlement combinations", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    await prisma.outboxEvent.create({
      data: {
        id: fixture.outboxId,
        eventType: "deployment.requested.v1",
        aggregateType: "deployment",
        aggregateId: fixture.deploymentId,
        payload: { eventId: fixture.outboxId },
      },
    });

    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "outbox_events" SET "claim_token" = ${randomUUID()} WHERE "id" = ${fixture.outboxId}`,
      ),
      "outbox_events_claim_all_or_none_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "outbox_events" SET "attempts" = -1 WHERE "id" = ${fixture.outboxId}`,
      ),
      "outbox_attempt_metadata_coherent_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "outbox_events" SET "published_at" = CURRENT_TIMESTAMP, "dead_lettered_at" = CURRENT_TIMESTAMP, "dead_letter_reason" = 'publish attempt exhausted' WHERE "id" = ${fixture.outboxId}`,
      ),
      "outbox_events_published_dead_letter_exclusive_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "outbox_events" SET "dead_lettered_at" = CURRENT_TIMESTAMP WHERE "id" = ${fixture.outboxId}`,
      ),
      "outbox_dead_letter_metadata_coherent_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "outbox_events" SET "claim_token" = ${randomUUID()}, "claim_owner" = ' ', "claim_expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 minute' WHERE "id" = ${fixture.outboxId}`,
      ),
      "outbox_claim_owner_nonempty_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "outbox_events" SET "attempts" = 1 WHERE "id" = ${fixture.outboxId}`,
      ),
      "outbox_attempt_metadata_coherent_check",
    );

    const row = await prisma.outboxEvent.findUnique({ where: { id: fixture.outboxId } });
    expect(row).toMatchObject({
      id: fixture.outboxId,
      attempts: 0,
      publishedAt: null,
      deadLetteredAt: null,
    });
  });

  it("fences deployment leases and rejects invalid Kafka delivery state", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);

    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "deployments" SET "lease_owner" = 'worker-a' WHERE "id" = ${fixture.deploymentId}`,
      ),
      "deployments_lease_claim_all_or_none_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "deployments" SET "lease_token" = ${randomUUID()}, "lease_owner" = 'worker-a', "lease_generation" = 0, "lease_acquired_at" = CURRENT_TIMESTAMP, "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 minute', "status" = 'CLONING' WHERE "id" = ${fixture.deploymentId}`,
      ),
      "deployments_active_lease_generation_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "deployments" SET "lease_token" = ${randomUUID()}, "lease_owner" = 'worker-a', "lease_generation" = 1, "lease_acquired_at" = CURRENT_TIMESTAMP, "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 minute', "status" = 'QUEUED' WHERE "id" = ${fixture.deploymentId}`,
      ),
      "deployments_active_lease_status_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "deployments" SET "lease_token" = ${randomUUID()}, "lease_owner" = ' ', "lease_generation" = 1, "lease_acquired_at" = CURRENT_TIMESTAMP, "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 minute', "status" = 'CLONING' WHERE "id" = ${fixture.deploymentId}`,
      ),
      "deployments_active_lease_owner_nonempty_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "deployments" SET "lease_token" = ${randomUUID()}, "lease_owner" = 'worker-a', "lease_generation" = 1, "lease_acquired_at" = CURRENT_TIMESTAMP, "lease_expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 minute', "status" = 'CLONING' WHERE "id" = ${fixture.deploymentId}`,
      ),
      "deployments_active_lease_timestamps_coherent_check",
    );

    const delivery = await prisma.kafkaDelivery.create({
      data: {
        id: fixture.kafkaDeliveryId,
        consumerName: "m3-migration-test",
        topic: "previewforge.deployment-requests.v1",
        partition: 0,
        offset: BigInt(Date.now()),
        eventId: fixture.outboxId,
        eventType: "deployment.requested.v1",
        environmentId: fixture.environmentId,
        aggregateId: fixture.deploymentId,
        payloadDigest: "a".repeat(64),
      },
    });
    expect(delivery).not.toHaveProperty("payload");
    expect(delivery.status).toBe("RECEIVED");

    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "kafka_deliveries" SET "payload_digest" = 'raw-payload' WHERE "id" = ${fixture.kafkaDeliveryId}`,
      ),
      "kafka_deliveries_payload_digest_sha256_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "kafka_deliveries" SET "status" = 'DEAD_LETTER', "dead_lettered_at" = CURRENT_TIMESTAMP WHERE "id" = ${fixture.kafkaDeliveryId}`,
      ),
      "kafka_deliveries_status_error_consistency_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "kafka_deliveries" SET "partition" = -1 WHERE "id" = ${fixture.kafkaDeliveryId}`,
      ),
      "kafka_deliveries_partition_nonnegative_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "kafka_deliveries" SET "error_code" = 'invalid-code', "status" = 'RETRY_SCHEDULED', "error_message" = 'retry later' WHERE "id" = ${fixture.kafkaDeliveryId}`,
      ),
      "kafka_deliveries_error_code_format_check",
    );
    await expectConstraintViolation(
      prisma.$executeRaw(
        Prisma.sql`UPDATE "kafka_deliveries" SET "attempts" = 2 WHERE "id" = ${fixture.kafkaDeliveryId}`,
      ),
      "kafka_deliveries_attempt_metadata_coherent_check",
    );

    await prisma.kafkaDelivery.update({
      where: { id: fixture.kafkaDeliveryId },
      data: {
        status: "DEAD_LETTER",
        deadLetteredAt: new Date(),
        errorCode: "INVALID_EVENT",
        errorMessage: "event identity mismatch",
      },
    });
    const validDeadLetterId = randomUUID();
    fixture.kafkaDeliveryIds.push(validDeadLetterId);
    const validDeadLetter = await prisma.kafkaDelivery.create({
      data: {
        id: validDeadLetterId,
        consumerName: "m3-migration-test",
        topic: "previewforge.deployment-requests.v1",
        partition: 0,
        offset: BigInt(Date.now()) + 1n,
        payloadDigest: "b".repeat(64),
        status: "DEAD_LETTER",
        deadLetteredAt: new Date(),
        errorCode: "INVALID_EVENT",
        errorMessage: "event identity mismatch",
      },
    });
    expect(validDeadLetter).toMatchObject({
      id: validDeadLetterId,
      status: "DEAD_LETTER",
      errorCode: "INVALID_EVENT",
      errorMessage: "event identity mismatch",
    });
  });
});

async function expectConstraintViolation(
  operation: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }

  expect(error, `expected PostgreSQL constraint ${constraintName} to reject`).toBeDefined();
  const message = error instanceof Error ? error.message : String(error);
  const metadata =
    typeof error === "object" && error !== null && "meta" in error
      ? JSON.stringify(error.meta)
      : "";
  expect(`${message} ${metadata}`).toContain("23514");
  expect(`${message} ${metadata}`).toContain(constraintName);
}

type Fixture = {
  userId: string;
  environmentId: string;
  deploymentId: string;
  outboxId: string;
  receiptId: string;
  kafkaDeliveryId: string;
  kafkaDeliveryIds: string[];
  outboxIds: string[];
  receiptIds: string[];
  commitSha: string;
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const outboxId = randomUUID();
  const receiptId = randomUUID();
  const kafkaDeliveryId = randomUUID();
  const commitSha = suffix.replaceAll("-", "").padEnd(40, "0").slice(0, 40);

  await prisma.user.create({
    data: {
      id: userId,
      githubUserId: `m3-migration-${suffix}`,
      githubLogin: `m3-migration-${suffix}`,
    },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000)),
      accountLogin: `m3-migration-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `m3-migration/${suffix}`,
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      previewKey: `m3-migration-${suffix}`,
      desiredCommitSha: commitSha,
    },
  });
  await prisma.deployment.create({
    data: { id: deploymentId, environmentId, commitSha },
  });

  return {
    userId,
    environmentId,
    deploymentId,
    outboxId,
    receiptId,
    kafkaDeliveryId,
    kafkaDeliveryIds: [kafkaDeliveryId],
    outboxIds: [outboxId],
    receiptIds: [receiptId],
    commitSha,
  };
}
