import { describe, expect, it } from "vitest";
import {
  buildkitEnvironment,
  DEFAULT_KAFKA_PORT,
  DEFAULT_KIND_HTTP_HOST_PORT,
  DEFAULT_KIND_HTTPS_HOST_PORT,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_REGISTRY_PORT,
  DEFAULT_STATE_DIRECTORY,
  environmentForState,
  isProcessAlive,
  parseBuildkitAddress,
  parseDotEnv,
  parseManagedCommand,
  resolveStateDirectory,
} from "./runtime.mjs";

describe("local runtime helpers", () => {
  it("parses quoted, escaped, exported, and commented environment values", () => {
    expect(
      parseDotEnv(
        [
          "# comment",
          "export DATABASE_URL=postgresql://localhost/db # local only",
          'GITHUB_PRIVATE_KEY="line-one\\nline-two"',
          "EMPTY=",
          "SINGLE='literal # value'",
        ].join("\n"),
      ),
    ).toEqual({
      DATABASE_URL: "postgresql://localhost/db",
      GITHUB_PRIVATE_KEY: "line-one\nline-two",
      EMPTY: "",
      SINGLE: "literal # value",
    });
  });

  it("accepts only exact temporary ownership roots", () => {
    expect(resolveStateDirectory()).toBe(DEFAULT_STATE_DIRECTORY);
    expect(resolveStateDirectory("/tmp/previewforge-local-test")).toBe(
      "/tmp/previewforge-local-test",
    );
    expect(() => resolveStateDirectory("/home/user/previewforge-local")).toThrow(
      "below /tmp or /var/tmp",
    );
    expect(() => resolveStateDirectory("/tmp/other-state")).toThrow(
      "previewforge-local directory name",
    );
  });

  it("keeps the local registry port explicit and bounded", () => {
    expect(DEFAULT_REGISTRY_PORT).toBe(55000);
    expect(DEFAULT_POSTGRES_PORT).toBe(55432);
    expect(DEFAULT_KAFKA_PORT).toBe(59092);
    expect(DEFAULT_KIND_HTTP_HOST_PORT).toBe(30080);
    expect(DEFAULT_KIND_HTTPS_HOST_PORT).toBe(30443);
  });

  it("does not report an impossible process as alive", () => {
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it("reuses the persisted Docker and Kubernetes identities for status and teardown", () => {
    const result = environmentForState(
      {
        COMPOSE_FILE: "/tmp/unrelated-compose.yaml",
        COMPOSE_PROJECT_NAME: "unrelated",
        DOCKER_CONTEXT: "current",
        DOCKER_HOST: "unix:///tmp/unrelated-docker.sock",
        PREVIEWFORGE_DOCKER_CONTEXT: "current",
        PREVIEWFORGE_KIND_CLUSTER: "current-cluster",
        KUBECONFIG: "/tmp/current-kubeconfig",
      },
      {
        dockerContext: "saved",
        clusterName: "saved-cluster",
        kubeconfig: "/var/tmp/previewforge-local-saved/kubeconfig",
      },
    );
    expect(result).toMatchObject({
      DOCKER_CONTEXT: "saved",
      PREVIEWFORGE_DOCKER_CONTEXT: "saved",
      PREVIEWFORGE_KIND_CLUSTER: "saved-cluster",
      KUBECONFIG: "/var/tmp/previewforge-local-saved/kubeconfig",
      KUBE_CONTEXT: "kind-saved-cluster",
      COMPOSE_PROJECT_NAME: "previewforge",
    });
    expect(result).not.toHaveProperty("COMPOSE_FILE");
    expect(result).not.toHaveProperty("DOCKER_HOST");
  });

  it("accepts only local Unix BuildKit boundaries and valid managed commands", () => {
    expect(parseBuildkitAddress("unix:///var/tmp/buildkitd.sock")).toEqual({
      address: "unix:///var/tmp/buildkitd.sock",
      socketPath: "/var/tmp/buildkitd.sock",
    });
    expect(() => parseBuildkitAddress("tcp://127.0.0.1:1234")).toThrow("unix:/// socket");
    expect(() => parseBuildkitAddress("unix:///var/run/docker.sock")).toThrow(
      "must not target a Docker socket",
    );
    expect(parseManagedCommand('["/usr/local/bin/buildkitd","--debug"]')).toEqual([
      "/usr/local/bin/buildkitd",
      "--debug",
    ]);
    expect(() => parseManagedCommand('["/usr/local/bin/buildkitd",""]')).toThrow(
      "non-empty JSON string array",
    );
  });

  it("scrubs application credentials from a managed BuildKit environment", () => {
    const environment = buildkitEnvironment({
      HOME: "/home/example",
      PATH: "/usr/bin",
      BUILDKIT_ADDR: "unix:///var/tmp/buildkitd.sock",
      GITHUB_APP_PRIVATE_KEY: "secret",
      DATABASE_URL: "postgresql://secret",
    });
    expect(environment).toEqual({
      HOME: "/home/example",
      PATH: "/usr/bin",
      BUILDKIT_ADDR: "unix:///var/tmp/buildkitd.sock",
    });
  });
});
