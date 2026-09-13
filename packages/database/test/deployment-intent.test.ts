import { describe, expect, it } from "vitest";
import {
  DeploymentRequestedValidationError,
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
