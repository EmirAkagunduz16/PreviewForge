import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SourceArchive } from "../source/github-source.js";

const execFileAsync = promisify(execFile);

export type DisposableBuildContext = {
  readonly contextPath: string;
  readonly dockerfilePath: string;
  cleanup(): Promise<void>;
};

export type SourceContextOptions = {
  tempRoot?: string;
  tarPath?: string;
  maxOutputBytes?: number;
};

/**
 * Materializes a GitHub archive outside the BuildKit process boundary. The
 * returned context owns its temporary directory and must be cleaned up by the
 * caller before any installation token is discarded.
 */
export async function materializeSourceContext(
  archive: SourceArchive,
  options: SourceContextOptions = {},
): Promise<DisposableBuildContext> {
  const contextPath = await mkdtemp(join(options.tempRoot ?? tmpdir(), "previewforge-context-"));
  const archivePath = join(contextPath, "source.tar.gz");
  try {
    await writeFile(archivePath, archive.bytes, { mode: 0o600 });
    await execFileAsync(
      options.tarPath ?? "tar",
      [
        "--extract",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        contextPath,
        "--no-same-owner",
        "--no-same-permissions",
        "--strip-components=1",
        "--warning=no-unknown-keyword",
      ],
      {
        maxBuffer: options.maxOutputBytes ?? 64 * 1024,
        windowsHide: true,
      },
    );
    await rm(archivePath, { force: true });

    const dockerfilePath = resolve(contextPath, archive.dockerfilePath);
    if (!dockerfilePath.startsWith(`${resolve(contextPath)}/`)) {
      throw new Error("Dockerfile path escapes source context");
    }
    const dockerfile = await stat(dockerfilePath).catch(() => undefined);
    if (dockerfile === undefined) {
      throw new Error("Dockerfile path is not a regular file");
    }
    if (!dockerfile.isFile()) throw new Error("Dockerfile path is not a regular file");
    return {
      contextPath,
      dockerfilePath: archive.dockerfilePath,
      cleanup: () => rm(contextPath, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(contextPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
