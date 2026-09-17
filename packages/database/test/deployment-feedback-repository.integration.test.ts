import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  DeploymentFeedbackRepository,
  type PrismaClient,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const CONSUMER = "feedback-integration";

describe("DeploymentFeedbackRepository (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let repository: DeploymentFeedbackRepository;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    repository = new DeploymentFeedbackRepository(prisma, () => 0);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await prisma.consumerReceipt.deleteMany({ where: { eventId: { in: fixture.eventIds } } });
      await prisma.kafkaDelivery.deleteMany({
        where: { consumerName: CONSUMER, eventId: { in: fixture.eventIds } },
      });
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    await prisma.$disconnect();
  });

  it("atomically chooses one Check Run identity during concurrent claims and reuses it", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const candidates = ["101", "202", "303", "404"];

    const claims = await Promise.all(
      candidates.map((checkRunId) =>
        repository.claimCheckRunId({ deploymentId: fixture.deploymentId, checkRunId }),
      ),
    );
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const stored = await repository.findByDeploymentId(fixture.deploymentId);
    expect(stored?.checkRunId).toBe(
      candidates.find((id) => claims.some((claim) => claim.claimed && claim.checkRunId === id)),
    );

    const repeated = await repository.claimCheckRunId({
      deploymentId: fixture.deploymentId,
      checkRunId: stored?.checkRunId ?? "101",
    });
    expect(repeated).toMatchObject({ claimed: true, checkRunId: stored?.checkRunId });
  });

  it("serializes remote recovery under the deployment row lock", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const eventIds = [randomUUID(), randomUUID()];
    let remoteCreates = 0;

    await Promise.all(
      eventIds.map((eventId) =>
        repository.withDeploymentLock(fixture.deploymentId, async (lock) => {
          if (lock.context?.checkRunId === null) {
            remoteCreates += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            await lock.storeCheckRunId("505");
          }
          if (!(await lock.isEventProcessed(eventId, CONSUMER))) {
            await lock.markEventProcessed(eventId, CONSUMER);
          }
        }),
      ),
    );

    expect(remoteCreates).toBe(1);
    expect((await repository.findByDeploymentId(fixture.deploymentId))?.checkRunId).toBe("505");
    expect(
      await prisma.consumerReceipt.count({
        where: { consumerName: CONSUMER, eventId: { in: eventIds } },
      }),
    ).toBe(2);
    fixture.eventIds.push(...eventIds);
  });

  it("tracks feedback delivery attempts without persisting payloads or secret-shaped errors", async () => {
    const fixture = await createFixture(prisma);
    fixtures.push(fixture);
    const delivery = {
      consumerName: CONSUMER,
      topic: "previewforge.deployment-events.v1",
      partition: 0,
      offset: fixture.offset,
      payloadDigest: "a".repeat(64),
      eventId: fixture.eventId,
      eventType: "deployment.ready.v1",
      environmentId: fixture.environmentId,
      aggregateId: fixture.deploymentId,
    };
    await expect(repository.claimDelivery(delivery)).resolves.toMatchObject({ kind: "CLAIMED" });
    await repository.scheduleRetry({
      delivery,
      errorCode: "CHECKS_RATE_LIMITED",
      message: "temporary authorization Bearer ghp_should-not-persist",
      maxAttempts: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });
    const stored = await prisma.kafkaDelivery.findUnique({
      where: {
        consumerName_topic_partition_offset: {
          consumerName: CONSUMER,
          topic: delivery.topic,
          partition: 0,
          offset: BigInt(fixture.offset),
        },
      },
    });
    expect(stored).toMatchObject({ status: "RETRY_SCHEDULED", errorCode: "CHECKS_RATE_LIMITED" });
    expect(stored?.errorMessage).not.toContain("ghp_should-not-persist");
  });
});

type Fixture = {
  userId: string;
  deploymentId: string;
  environmentId: string;
  projectId: string;
  installationId: string;
  commitSha: string;
  eventId: string;
  offset: number;
  eventIds: string[];
};

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const pullRequestId = randomUUID();
  const deploymentId = randomUUID();
  const commitSha = suffix.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
  const eventId = randomUUID();
  const offset = Math.floor(Math.random() * 1_000_000_000) + 1;

  await prisma.user.create({
    data: { id: userId, githubUserId: `feedback-${suffix}`, githubLogin: `feedback-${suffix}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Math.floor(Math.random() * 2_000_000_000) + 1),
      accountLogin: `feedback-${suffix}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `feedback/${suffix}`,
    },
  });
  await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number: 1,
      headSha: commitSha,
      state: "OPEN",
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      previewKey: `feedback-${suffix}`,
      desiredCommitSha: commitSha,
      pullRequestId,
    },
  });
  await prisma.deployment.create({
    data: {
      id: deploymentId,
      environmentId,
      commitSha,
      status: "READY",
      imageDigest: `sha256:${"b".repeat(64)}`,
    },
  });

  return {
    userId,
    deploymentId,
    environmentId,
    projectId,
    installationId,
    commitSha,
    eventId,
    offset,
    eventIds: [eventId],
  };
}
