import { describe, expect, it } from "vitest";
import { resolveBuildInput } from "./build-input.js";

const event = {
  eventId: "019930c0-c522-7474-a3f0-1ee461901c20",
  eventType: "deployment.requested.v1" as const,
  occurredAt: "2026-09-12T17:00:00.000Z",
  deploymentId: "019930c0-c522-7474-a3f0-1ee461901c21",
  environmentId: "019930c0-c522-7474-a3f0-1ee461901c22",
  projectId: "019930c0-c522-7474-a3f0-1ee461901c23",
  installationId: "42",
  repositoryFullName: "acme/store",
  pullRequestNumber: 7,
  commitSha: "7dc12ab7dc12ab7dc12ab7dc12ab7dc12ab7dc12",
};

describe("resolveBuildInput", () => {
  it("derives an immutable transport reference from the deployment identity", () => {
    expect(
      resolveBuildInput(
        event,
        {
          githubInstallationId: "42",
          repositoryFullName: "acme/store",
          dockerfilePath: "deploy/Dockerfile",
        },
        { registryHost: "registry.local:5000" },
      ),
    ).toEqual({
      source: {
        installationId: "42",
        repositoryFullName: "acme/store",
        commitSha: event.commitSha,
        dockerfilePath: "deploy/Dockerfile",
      },
      imageReference: `registry.local:5000/${event.projectId}/${event.deploymentId}:${event.commitSha}`,
    });
  });

  it("rejects project identity and unsafe Dockerfile mismatches", () => {
    expect(() =>
      resolveBuildInput(
        event,
        {
          githubInstallationId: "99",
          repositoryFullName: "acme/store",
          dockerfilePath: "Dockerfile",
        },
        { registryHost: "registry.local" },
      ),
    ).toThrow("installation");
    expect(() =>
      resolveBuildInput(
        event,
        {
          githubInstallationId: "42",
          repositoryFullName: "acme/store",
          dockerfilePath: "../Dockerfile",
        },
        { registryHost: "registry.local" },
      ),
    ).toThrow("Dockerfile");
  });
});
