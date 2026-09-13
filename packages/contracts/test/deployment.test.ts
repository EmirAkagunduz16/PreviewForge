import { describe, expect, it } from "vitest";
import { canTransitionDeployment, deploymentRequestedSchema } from "../src/index.js";

describe("deployment state machine", () => {
  it("allows the happy path", () => {
    expect(canTransitionDeployment("QUEUED", "CLONING")).toBe(true);
    expect(canTransitionDeployment("BUILDING", "PUSHING")).toBe(true);
    expect(canTransitionDeployment("WAITING_FOR_HEALTHCHECK", "READY")).toBe(true);
  });

  it("does not resurrect terminal deployments", () => {
    expect(canTransitionDeployment("FAILED", "QUEUED")).toBe(false);
    expect(canTransitionDeployment("SUPERSEDED", "DEPLOYING")).toBe(false);
  });
});

describe("deployment.requested.v1", () => {
  it("rejects abbreviated commit SHAs", () => {
    const result = deploymentRequestedSchema.safeParse({
      eventId: "019930c0-c522-7474-a3f0-1ee461901c20",
      eventType: "deployment.requested.v1",
      occurredAt: "2026-09-12T17:00:00.000Z",
      deploymentId: "019930c0-c522-7474-a3f0-1ee461901c21",
      environmentId: "019930c0-c522-7474-a3f0-1ee461901c22",
      projectId: "019930c0-c522-7474-a3f0-1ee461901c23",
      installationId: 42,
      repositoryFullName: "acme/store",
      pullRequestNumber: 7,
      commitSha: "7dc12ab",
    });

    expect(result.success).toBe(false);
  });
});
