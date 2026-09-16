import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("rejects TCP BuildKit endpoints", () => {
    expect(() => new BuildKitAdapter({ address: "tcp://buildkit:1234" })).toThrow(
      "Invalid BuildKit address",
    );
  });

  it("runs a credential-free build and returns the immutable metadata digest", async () => {
    const root = await temporaryDirectory();
    const calls: { executable: string; args: readonly string[] }[] = [];
    const output: string[] = [];
    const adapter = new BuildKitAdapter({
      address: "unix:///var/tmp/buildkitd.sock",
      tempRoot: root,
      run: async (executable, args, _options, onOutput) => {
        calls.push({ executable, args });
        await onOutput({ stream: "stdout", text: "build " });
        await onOutput({ stream: "stderr", text: "pushing\n" });
        const metadataPath = args[args.indexOf("--metadata-file") + 1];
        await writeFile(
          metadataPath ?? "",
          JSON.stringify({ "containerimage.digest": `sha256:${"a".repeat(64)}` }),
        );
        return;
      },
    });

    await expect(
      adapter.buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "localhost:55000/previewforge/demo:deployment-1",
        onOutput: async ({ stream, text }) => {
          output.push(`${stream}:${text}`);
        },
      }),
    ).resolves.toEqual({
      imageReference: "localhost:55000/previewforge/demo:deployment-1",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(calls[0]?.executable).toBe("buildctl");
    expect(calls[0]?.args).toContain("--addr");
    expect(calls[0]?.args).toContain("unix:///var/tmp/buildkitd.sock");
    expect(calls[0]?.args.join(" ")).not.toContain("password");
    expect(calls[0]?.args.join(" ")).not.toContain("token");
    expect(output).toEqual(["stdout:build ", "stderr:pushing\n"]);
    await expect(readFile(join(root, "metadata.json"))).rejects.toThrow();
  });

  it("streams stdout/stderr with callback backpressure and normalizes persistence errors", async () => {
    const root = await temporaryDirectory();
    const events: string[] = [];
    const adapter = new BuildKitAdapter({
      address: "unix:///var/tmp/buildkitd.sock",
      tempRoot: root,
      run: async (_executable, args, _options, onOutput) => {
        const first = onOutput({ stream: "stdout", text: "one" });
        const second = onOutput({ stream: "stderr", text: "two" });
        await Promise.all([first, second]);
        const metadataPath = args[args.indexOf("--metadata-file") + 1];
        await writeFile(
          metadataPath ?? "",
          JSON.stringify({ "containerimage.digest": `sha256:${"c".repeat(64)}` }),
        );
      },
    });
    await adapter.buildAndPush({
      contextPath: root,
      dockerfilePath: "Dockerfile",
      imageReference: "registry/demo:build",
      onOutput: async ({ stream, text }) => {
        events.push(`start:${stream}:${text}`);
        if (text === "one") await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end:${stream}:${text}`);
      },
    });
    expect(events).toEqual([
      "start:stdout:one",
      "end:stdout:one",
      "start:stderr:two",
      "end:stderr:two",
    ]);

    const failing = new BuildKitAdapter({
      address: "unix:///var/tmp/buildkitd.sock",
      tempRoot: root,
      run: async (_executable, _args, _options, onOutput) => {
        await onOutput({ stream: "stderr", text: "raw-secret-output" });
      },
    });
    const persistenceError = await failing
      .buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "registry/demo:build",
        onOutput: async () => {
          throw new Error("database-password-private");
        },
      })
      .catch((error: unknown) => error);
    expect(persistenceError).toMatchObject({
      code: "BUILDKIT_LOG_PERSISTENCE_FAILED",
      retryable: true,
    });
    expect(String(persistenceError)).not.toContain("database-password-private");
  });

  it("uses the real spawned process stream and passes no worker secret environment", async () => {
    const root = await temporaryDirectory();
    const script = join(root, "buildctl-fixture.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        "previous=",
        'for argument in "$@"; do',
        '  if [ "$previous" = metadata ]; then printf \'%s\' \'{"containerimage.digest":"sha256:' +
          "d".repeat(64) +
          '"}\' > "$argument"; fi',
        '  if [ "$argument" = --metadata-file ]; then previous=metadata; else previous=; fi',
        "done",
        "printf '%s\\n' 'stdout-first'",
        "printf '%s\\n' \"${" + "PREVIEWFORGE_PRIVATE_SENTINEL-absent}" + '" >&2',
      ].join("\n"),
    );
    await chmod(script, 0o755);
    const original = process.env.PREVIEWFORGE_PRIVATE_SENTINEL;
    process.env.PREVIEWFORGE_PRIVATE_SENTINEL = "do-not-pass-to-buildkit";
    const observed: string[] = [];
    try {
      const adapter = new BuildKitAdapter({
        address: "unix:///var/tmp/buildkitd.sock",
        buildctlPath: script,
        tempRoot: root,
        timeoutMs: 2_000,
      });
      await adapter.buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "registry/demo:build",
        onOutput: async ({ stream, text }) => {
          observed.push(`${stream}:${text}`);
        },
      });
    } finally {
      if (original === undefined) delete process.env.PREVIEWFORGE_PRIVATE_SENTINEL;
      else process.env.PREVIEWFORGE_PRIVATE_SENTINEL = original;
    }
    expect(observed.join("")).toContain("stdout:stdout-first");
    expect(observed.join("")).toContain("stderr:absent");
    expect(observed.join("")).not.toContain("do-not-pass-to-buildkit");
  });

  it("escalates to SIGKILL when a timed-out child ignores SIGTERM", async () => {
    const root = await temporaryDirectory();
    const pidPath = join(root, "child.pid");
    const termPath = join(root, "term.received");
    const script = join(root, "ignore-term.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `echo $$ > '${pidPath}'`,
        `trap "echo received > '${termPath}'" TERM`,
        "while :; do :; done",
      ].join("\n"),
    );
    await chmod(script, 0o755);
    const adapter = new BuildKitAdapter({
      address: "unix:///var/tmp/buildkitd.sock",
      buildctlPath: script,
      tempRoot: root,
      timeoutMs: 50,
    });

    await expect(
      adapter.buildAndPush({
        contextPath: root,
        dockerfilePath: "Dockerfile",
        imageReference: "registry/demo:build",
      }),
    ).rejects.toMatchObject({ code: "BUILDKIT_TIMEOUT", retryable: true });

    const pid = Number((await readFile(pidPath, "utf8")).trim());
    await expect(readFile(termPath, "utf8")).resolves.toContain("received");
    await expect(waitForProcessExit(pid)).resolves.toBeUndefined();
  });

  it.each([
    ["ENOENT", "BUILDKIT_UNAVAILABLE", true],
    ["ECONNREFUSED", "BUILDKIT_UNAVAILABLE", true],
    ["ETIMEDOUT", "BUILDKIT_TIMEOUT", true],
    ["EFAIL", "BUILDKIT_FAILED", false],
  ])("maps buildctl %s to a safe infrastructure error", async (code, expected, retryable) => {
    const root = await temporaryDirectory();
    const adapter = new BuildKitAdapter({
      address: "unix:///var/tmp/buildkitd.sock",
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
      address: "unix:///var/tmp/buildkitd.sock",
      tempRoot: root,
      run: async (_executable, args) => {
        const metadataPath = args[args.indexOf("--metadata-file") + 1];
        await writeFile(metadataPath ?? "", JSON.stringify({ "containerimage.digest": "latest" }));
        return;
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
    ["unix:///var/tmp/buildkitd.sock", "docker socket", "unix:///var/run/docker.sock"],
    ["unix:///var/tmp/buildkitd.sock", "path traversal", "../Dockerfile"],
  ])("rejects unsafe build input (%s)", async (address, _label, dockerfilePath) => {
    const root = await temporaryDirectory();
    const adapter = new BuildKitAdapter({
      address,
      tempRoot: root,
      run: async () => undefined,
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

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} was not killed after timeout escalation`);
}
