import { describe, expect, it } from "vitest";
import {
  DeploymentIntentRepository,
  DeploymentRequestedValidationError,
  type PrismaClient,
  parseDeploymentRequestedPayload,
} from "../src/index.js";

const validPayload = {
  eventId: "019930c0-c522-7474-a3f0-1ee461901c20",
  eventType: "deployment.requested.v1",
  occurredAt: "2026-09-12T17:00:00.000Z",
  deploymentId: "019930c0-c522-7474-a3f0-1ee461901c21",
  environmentId: "019930c0-c522-7474-a3f0-1ee461901c22",
  projectId: "019930c0-c522-7474-a3f0-1ee461901c23",
  installationId: "42",
  repositoryFullName: "acme/store",
  pullRequestNumber: 7,
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

describe("deployment.requested.v1 boundary", () => {
  it("normalizes the allow-listed fields and drops unknown data", () => {
    const parsed = parseDeploymentRequestedPayload({
      ...validPayload,
      secret: "must-not-be-persisted",
    });

    expect(parsed).toEqual(validPayload);
    expect(parsed).not.toHaveProperty("secret");
  });

  it("rejects malformed payloads before database work", () => {
    expect(() =>
      parseDeploymentRequestedPayload({
        ...validPayload,
        commitSha: "7dc12ab",
      }),
    ).toThrow(DeploymentRequestedValidationError);
    expect(() =>
      parseDeploymentRequestedPayload({
        ...validPayload,
        eventType: "deployment.stage-changed.v1",
      }),
    ).toThrow(DeploymentRequestedValidationError);
  });
});

describe("deployment intent serialization retries", () => {
  it.each([
    {
      name: "direct adapter error",
      error: Object.assign(new Error("serialization failure"), {
        kind: "TransactionWriteConflict",
        originalCode: "40001",
      }),
    },
    {
      name: "nested adapter cause",
      error: Object.assign(new Error("deadlock failure"), {
        cause: { kind: "TransactionWriteConflict", originalCode: "40P01" },
      }),
    },
  ])("retries a $name", async ({ error }) => {
    const fake = transactionClient([error]);
    const result = await new DeploymentIntentRepository(fake.client).createDeploymentIntent(
      validPayload,
    );

    expect(result.created).toBe(true);
    expect(fake.attempts()).toBe(2);
  });

  it.each([
    Object.assign(new Error("wrong SQLSTATE"), {
      kind: "TransactionWriteConflict",
      originalCode: "23505",
    }),
    Object.assign(new Error("wrong adapter kind"), {
      kind: "UniqueConstraintViolation",
      originalCode: "40001",
    }),
  ])("does not retry an unrelated lookalike", async (error) => {
    const fake = transactionClient([error]);

    await expect(
      new DeploymentIntentRepository(fake.client).createDeploymentIntent(validPayload),
    ).rejects.toBe(error);
    expect(fake.attempts()).toBe(1);
  });

  it("fails closed after the bounded serialization retry budget", async () => {
    const error = Object.assign(new Error("persistent serialization failure"), {
      kind: "TransactionWriteConflict",
      originalCode: "40001",
    });
    const fake = transactionClient(Array.from({ length: 9 }, () => error));

    await expect(
      new DeploymentIntentRepository(fake.client).createDeploymentIntent(validPayload),
    ).rejects.toBe(error);
    expect(fake.attempts()).toBe(9);
  });
});

function transactionClient(errors: unknown[]): {
  client: PrismaClient;
  attempts: () => number;
} {
  let attempts = 0;
  const client = {
    $transaction: async () => {
      const error = errors[attempts];
      attempts += 1;
      if (error !== undefined) {
        throw error;
      }
      return { created: true };
    },
  } as unknown as PrismaClient;

  return { client, attempts: () => attempts };
}
