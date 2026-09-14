import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuildKitAdapter } from "./buildkit-adapter.js";

const buildkitAddress = process.env.BUILDKIT_ADDR;
const registryHost = process.env.REGISTRY_URL;
if (!buildkitAddress) throw new Error("BUILDKIT_ADDR is required for BuildKit integration tests");
if (!registryHost) throw new Error("REGISTRY_URL is required for BuildKit integration tests");

const runId = randomUUID();
const repository = `previewforge/m4-${runId}`;
const imageReference = `${registryHost.replace(/\/$/u, "")}/${repository}:acceptance`;
const registryProtocol = process.env.REGISTRY_PROTOCOL ?? "http";

describe("rootless BuildKit and registry", () => {
  let contextPath: string;
  let digest: string;

  beforeAll(async () => {
    contextPath = await mkdtemp(join(tmpdir(), "previewforge-m4-build-"));
    await writeFile(join(contextPath, "message.txt"), "M4 acceptance\n");
    await writeFile(
      join(contextPath, "Dockerfile"),
      ["FROM scratch", "COPY message.txt /message.txt", ""].join("\n"),
    );
  });

  afterAll(async () => {
    if (digest !== undefined) {
      await fetch(
        `${registryProtocol}://${registryHost}/v2/${repository}/manifests/${encodeURIComponent(digest)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    if (contextPath !== undefined) await rm(contextPath, { recursive: true, force: true });
  });

  it("builds, pushes, and verifies the immutable registry digest", async () => {
    const result = await new BuildKitAdapter({
      address: buildkitAddress,
      timeoutMs: 120_000,
      maxOutputBytes: 2 * 1024 * 1024,
    }).buildAndPush({
      contextPath,
      dockerfilePath: "Dockerfile",
      imageReference,
    });
    digest = result.digest;
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const response = await fetch(
      `${registryProtocol}://${registryHost}/v2/${repository}/manifests/${encodeURIComponent(result.digest)}`,
      {
        headers: {
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("docker-content-digest")).toBe(result.digest);
  }, 180_000);
});
