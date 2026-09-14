const DEFAULT_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export type GitHubSourceRequest = {
  installationId: string;
  repositoryFullName: string;
  commitSha: string;
  dockerfilePath: string;
};

export type InstallationTokenProvider = (installationId: string) => Promise<string>;

export type SourceArchive = {
  repositoryFullName: string;
  commitSha: string;
  dockerfilePath: string;
  bytes: Uint8Array;
};

export type GitHubSourceClientOptions = {
  apiBaseUrl: string;
  tokenProvider: InstallationTokenProvider;
  fetch?: typeof fetch;
  maxArchiveBytes?: number;
};

export type SourceAcquisitionCode =
  | "SOURCE_INPUT_INVALID"
  | "SOURCE_UNAUTHORIZED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_RATE_LIMITED"
  | "SOURCE_UPSTREAM_FAILURE"
  | "SOURCE_RESPONSE_TOO_LARGE"
  | "SOURCE_INVALID_RESPONSE";

export class SourceAcquisitionError extends Error {
  override readonly name = "SourceAcquisitionError";

  constructor(
    readonly code: SourceAcquisitionCode,
    readonly retryable: boolean,
  ) {
    super(`Source acquisition failed: ${code}`);
  }
}

/**
 * Fetches a repository archive before a build starts. The token provider is
 * deliberately injected so token creation and source bytes remain separate
 * from the later BuildKit trust zone.
 */
export class GitHubSourceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: URL;
  private readonly maxArchiveBytes: number;

  constructor(private readonly options: GitHubSourceClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = requireOrigin(options.apiBaseUrl);
    this.maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    if (!Number.isSafeInteger(this.maxArchiveBytes) || this.maxArchiveBytes <= 0) {
      throw new Error("Invalid source archive size limit");
    }
  }

  async fetchArchive(input: GitHubSourceRequest): Promise<SourceArchive> {
    validateRequest(input);
    const [owner, repository] = input.repositoryFullName.split("/");
    if (owner === undefined || repository === undefined) {
      throw new SourceAcquisitionError("SOURCE_INPUT_INVALID", false);
    }

    let token: string;
    try {
      token = await this.options.tokenProvider(input.installationId);
    } catch {
      // Token-provider details may contain credentials or upstream responses;
      // convert them to the stable boundary error before they reach logs.
      throw new SourceAcquisitionError("SOURCE_UPSTREAM_FAILURE", true);
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
    }

    const endpoint = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball/${encodeURIComponent(input.commitSha)}`,
      this.apiBaseUrl,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "PreviewForge/1.0",
        },
        redirect: "manual",
      });
      response = await this.followArchiveRedirect(response);
    } catch (error) {
      if (error instanceof SourceAcquisitionError) throw error;
      throw new SourceAcquisitionError("SOURCE_UPSTREAM_FAILURE", true);
    }

    if (!response.ok) throw mapResponseError(response.status);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, this.maxArchiveBytes);
    } catch (error) {
      if (error instanceof SourceAcquisitionError) throw error;
      throw new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
    }

    return {
      repositoryFullName: input.repositoryFullName,
      commitSha: input.commitSha,
      dockerfilePath: input.dockerfilePath,
      bytes,
    };
  }

  private async followArchiveRedirect(response: Response): Promise<Response> {
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
    let redirect: URL;
    try {
      redirect = new URL(location, this.apiBaseUrl);
    } catch {
      throw new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
    }
    if (redirect.protocol !== "https:" && redirect.protocol !== "http:") {
      throw new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
    }
    if (redirect.username || redirect.password) {
      throw new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
    }

    try {
      // Never forward the installation token to the archive host.
      return await this.fetchImpl(redirect, { redirect: "error" });
    } catch {
      throw new SourceAcquisitionError("SOURCE_UPSTREAM_FAILURE", true);
    }
  }
}

function requireOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error();
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new Error("Invalid GitHub API origin");
  }
}

function validateRequest(input: GitHubSourceRequest): void {
  if (!/^[1-9][0-9]*$/.test(input.installationId)) {
    throw new SourceAcquisitionError("SOURCE_INPUT_INVALID", false);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName)) {
    throw new SourceAcquisitionError("SOURCE_INPUT_INVALID", false);
  }
  if (!/^[0-9a-f]{40}$/iu.test(input.commitSha)) {
    throw new SourceAcquisitionError("SOURCE_INPUT_INVALID", false);
  }
  if (
    input.dockerfilePath.length === 0 ||
    input.dockerfilePath.length > 256 ||
    input.dockerfilePath.startsWith("/") ||
    input.dockerfilePath.includes("\\") ||
    input.dockerfilePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
    input.dockerfilePath.includes("\u0000")
  ) {
    throw new SourceAcquisitionError("SOURCE_INPUT_INVALID", false);
  }
}

function mapResponseError(status: number): SourceAcquisitionError {
  if (status === 401 || status === 403) {
    return new SourceAcquisitionError("SOURCE_UNAUTHORIZED", false);
  }
  if (status === 404) return new SourceAcquisitionError("SOURCE_NOT_FOUND", false);
  if (status === 429) return new SourceAcquisitionError("SOURCE_RATE_LIMITED", true);
  if (status === 408 || status >= 500) {
    return new SourceAcquisitionError("SOURCE_UPSTREAM_FAILURE", true);
  }
  return new SourceAcquisitionError("SOURCE_INVALID_RESPONSE", false);
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit)
      throw new SourceAcquisitionError("SOURCE_RESPONSE_TOO_LARGE", false);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new SourceAcquisitionError("SOURCE_RESPONSE_TOO_LARGE", false);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
