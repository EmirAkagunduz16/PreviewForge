import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { materializeSourceContext } from "./source-context.js";

const execFileAsync = promisify(execFile);

describe("materializeSourceContext", () => {
  it("extracts a disposable archive and verifies the Dockerfile", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "previewforge-source-fixture-"));
    const archivePath = join(fixture, "source.tar.gz");
    try {
      const sourceRoot = join(fixture, "source-root");
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, "Dockerfile"), "FROM scratch\n");
      await writeFile(join(sourceRoot, "README.md"), "fixture\n");
      await execFileAsync("tar", [
        "--create",
        "--gzip",
        "--file",
        archivePath,
        "-C",
        fixture,
        "source-root",
      ]);
      const bytes = new Uint8Array(await readFile(archivePath));
      const context = await materializeSourceContext(
        {
          repositoryFullName: "previewforge/demo",
          commitSha: "a".repeat(40),
          dockerfilePath: "Dockerfile",
          bytes,
        },
        { tempRoot: fixture },
      );
      expect(await readFile(join(context.contextPath, "Dockerfile"), "utf8")).toBe(
        "FROM scratch\n",
      );
      await context.cleanup();
      await expect(readFile(context.contextPath)).rejects.toThrow();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a missing Dockerfile and removes the temporary context", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "previewforge-source-fixture-"));
    const archivePath = join(fixture, "source.tar.gz");
    try {
      const sourceRoot = join(fixture, "source-root");
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, "README.md"), "fixture\n");
      await execFileAsync("tar", [
        "--create",
        "--gzip",
        "--file",
        archivePath,
        "-C",
        fixture,
        "source-root",
      ]);
      const bytes = new Uint8Array(await readFile(archivePath));
      await expect(
        materializeSourceContext(
          {
            repositoryFullName: "previewforge/demo",
            commitSha: "b".repeat(40),
            dockerfilePath: "Dockerfile",
            bytes,
          },
          { tempRoot: fixture },
        ),
      ).rejects.toThrow("Dockerfile path is not a regular file");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
