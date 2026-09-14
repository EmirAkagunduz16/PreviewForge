import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildKitAdapter } from "./buildkit-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("BuildKitAdapter", () => {
  it("runs a credential-free build and returns the immutable metadata digest", async () => {
    const root = await temporaryDirectory();
    const calls: { executable: string; args: readonly string[] }[] = [];
    const adapter = new BuildKitAdapter({
      address: "tcp://buildkit:1234",
      tempRoot: root,
      run: async (executable, args) => {
        calls.push({ executable, args });
        const metadataPath = args[args.indexOf("--metadata-file") + 1];
        await writeFile(
          metadataPath ?? "",
          JSON.stringify({ "containerimage.digest": `sha256:${"a".repeat(64)}` }),
        );
        return { stdout: "build complete", stderr: "" };
      },
    });

    await expect(
      adapter.buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "localhost:55000/previewforge/demo:deployment-1",
      }),
    ).resolves.toEqual({
      imageReference: "localhost:55000/previewforge/demo:deployment-1",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(calls[0]?.executable).toBe("buildctl");
    expect(calls[0]?.args).toContain("--addr");
    expect(calls[0]?.args).toContain("tcp://buildkit:1234");
    expect(calls[0]?.args.join(" ")).not.toContain("password");
    expect(calls[0]?.args.join(" ")).not.toContain("token");
    await expect(readFile(join(root, "metadata.json"))).rejects.toThrow();
  });

  it.each([
    ["ENOENT", "BUILDKIT_UNAVAILABLE", true],
    ["ECONNREFUSED", "BUILDKIT_UNAVAILABLE", true],
    ["ETIMEDOUT", "BUILDKIT_TIMEOUT", true],
    ["EFAIL", "BUILDKIT_FAILED", false],
  ])("maps buildctl %s to a safe infrastructure error", async (code, expected, retryable) => {
    const root = await temporaryDirectory();
    const adapter = new BuildKitAdapter({
      address: "tcp://buildkit:1234",
      tempRoot: root,
      run: async () => {
        const error = new Error("secret-build-output-token") as Error & { code: string };
        error.code = code;
        throw error;
      },
    });
    const error = await adapter
      .buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "registry/demo:latest",
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: expected, retryable });
    expect(String(error)).not.toContain("secret-build-output-token");
  });

  it("rejects a missing or malformed digest instead of persisting a tag", async () => {
    const root = await temporaryDirectory();
    const adapter = new BuildKitAdapter({
      address: "tcp://buildkit:1234",
      tempRoot: root,
      run: async (_executable, args) => {
        const metadataPath = args[args.indexOf("--metadata-file") + 1];
        await writeFile(metadataPath ?? "", JSON.stringify({ "containerimage.digest": "latest" }));
        return { stdout: "", stderr: "" };
      },
    });
    await expect(
      adapter.buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "registry/demo:latest",
      }),
    ).rejects.toMatchObject({ code: "BUILDKIT_INVALID_DIGEST", retryable: false });
  });

  it.each([
    ["tcp://buildkit:1234", "docker socket", "unix:///var/run/docker.sock"],
    ["tcp://buildkit:1234", "path traversal", "../Dockerfile"],
  ])("rejects unsafe build input (%s)", async (address, _label, dockerfilePath) => {
    const root = await temporaryDirectory();
    const adapter = new BuildKitAdapter({
      address,
      tempRoot: root,
      run: async () => ({ stdout: "", stderr: "" }),
    });
    await expect(
      adapter.buildAndPush({
        contextPath: root,
        dockerfilePath,
        imageReference: "registry/demo:latest",
      }),
    ).rejects.toThrow("Invalid Dockerfile path");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "previewforge-buildkit-test-"));
  temporaryDirectories.push(path);
  return path;
}
