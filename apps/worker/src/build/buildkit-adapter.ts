import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type BuildKitInfrastructureCode =
  | "BUILDKIT_UNAVAILABLE"
  | "BUILDKIT_TIMEOUT"
  | "BUILDKIT_FAILED"
  | "BUILDKIT_INVALID_DIGEST";

export class BuildKitInfrastructureError extends Error {
  override readonly name = "BuildKitInfrastructureError";

  constructor(
    readonly code: BuildKitInfrastructureCode,
    readonly retryable: boolean,
  ) {
    super(`Build infrastructure failed: ${code}`);
  }
}

export type BuildKitBuildInput = {
  contextPath: string;
  dockerfilePath: string;
  imageReference: string;
};

export type BuildKitBuildResult = {
  imageReference: string;
  digest: `sha256:${string}`;
};

type BuildctlRunOptions = { timeout: number; maxBuffer: number };
type BuildctlRunner = (
  executable: string,
  args: readonly string[],
  options: BuildctlRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type BuildKitAdapterOptions = {
  address: string;
  buildctlPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  run?: BuildctlRunner;
  tempRoot?: string;
};

/**
 * Thin, credential-free buildctl adapter. BuildKit receives only a source
 * context and a transport image reference; no platform credential is passed
 * through args or environment.
 */
export class BuildKitAdapter {
  private readonly run: BuildctlRunner;
  private readonly buildctlPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly tempRoot: string;

  constructor(private readonly options: BuildKitAdapterOptions) {
    validateBuildKitAddress(options.address);
    this.run = options.run ?? defaultBuildctlRunner;
    this.buildctlPath = options.buildctlPath ?? "buildctl";
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS);
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.tempRoot = options.tempRoot ?? tmpdir();
  }

  async buildAndPush(input: BuildKitBuildInput): Promise<BuildKitBuildResult> {
    const contextPath = validateContextPath(input.contextPath);
    const dockerfilePath = validateDockerfilePath(input.dockerfilePath);
    const imageReference = validateImageReference(input.imageReference);
    const metadataDirectory = await mkdtemp(join(this.tempRoot, "previewforge-buildkit-"));
    const metadataPath = join(metadataDirectory, "metadata.json");
    const args = [
      "--addr",
      this.options.address,
      "build",
      "--progress",
      "plain",
      "--frontend",
      "dockerfile.v0",
      "--local",
      `context=${contextPath}`,
      "--local",
      `dockerfile=${contextPath}`,
      "--opt",
      `filename=${dockerfilePath}`,
      "--output",
      `type=image,name=${imageReference},push=true`,
      "--metadata-file",
      metadataPath,
    ] as const;

    try {
      await this.run(this.buildctlPath, args, {
        timeout: this.timeoutMs,
        maxBuffer: this.maxOutputBytes,
      });
      const metadata = await readMetadata(metadataPath);
      const digest = metadata["containerimage.digest"];
      if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
        throw new BuildKitInfrastructureError("BUILDKIT_INVALID_DIGEST", false);
      }
      return { imageReference, digest: digest as `sha256:${string}` };
    } catch (error) {
      if (error instanceof BuildKitInfrastructureError) throw error;
      throw classifyBuildctlError(error);
    } finally {
      await rm(metadataDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function defaultBuildctlRunner(
  executable: string,
  args: readonly string[],
  options: BuildctlRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(executable, [...args], {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    // Do not inherit DATABASE_URL, GitHub credentials, registry credentials,
    // or any other worker secret into the build client process.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
    },
  });
}

async function readMetadata(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new BuildKitInfrastructureError("BUILDKIT_INVALID_DIGEST", false);
  }
}

function classifyBuildctlError(error: unknown): BuildKitInfrastructureError {
  if (isRecord(error)) {
    if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      return new BuildKitInfrastructureError("BUILDKIT_UNAVAILABLE", true);
    }
    if (error.code === "ETIMEDOUT" || error.killed === true || error.signal === "SIGTERM") {
      return new BuildKitInfrastructureError("BUILDKIT_TIMEOUT", true);
    }
  }
  return new BuildKitInfrastructureError("BUILDKIT_FAILED", false);
}

function validateBuildKitAddress(value: string): void {
  if (!(value.startsWith("tcp://") || value.startsWith("unix://")) || value.includes("\u0000")) {
    throw new Error("Invalid BuildKit address");
  }
}

function validateContextPath(value: string): string {
  if (!isAbsolute(value) || value.includes("\u0000")) throw new Error("Invalid build context path");
  return resolve(value);
}

function validateDockerfilePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Invalid Dockerfile path");
  }
  return posix.normalize(value);
}

function validateImageReference(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    /\s/u.test(value) ||
    value.includes("\u0000") ||
    value.includes("@") ||
    value.includes("$") ||
    value.includes("`")
  ) {
    throw new Error("Invalid image reference");
  }
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid BuildKit limit");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
