const API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion = "success" | "failure" | "neutral" | "cancelled";

export type GitHubCheckRunRequest = {
  installationId: string;
  repositoryFullName: string;
  headSha: string;
  name: string;
  externalId: string;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
};

export type GitHubCheckRunRecord = {
  id: string;
  externalId: string | null;
  status: CheckRunStatus | null;
  conclusion: CheckRunConclusion | null;
};

export type GitHubCheckRunClientOptions = {
  apiBaseUrl: string;
  tokenProvider: (installationId: string) => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type GitHubCheckRunErrorCode =
  | "CHECKS_INPUT_INVALID"
  | "CHECKS_UNAUTHORIZED"
  | "CHECKS_FORBIDDEN"
  | "CHECKS_NOT_FOUND"
  | "CHECKS_RATE_LIMITED"
  | "CHECKS_UPSTREAM_FAILURE"
  | "CHECKS_INVALID_RESPONSE"
  | "CHECKS_TOKEN_FAILURE";

export class GitHubCheckRunError extends Error {
  override readonly name = "GitHubCheckRunError";

  constructor(
    readonly code: GitHubCheckRunErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`GitHub Check Run request failed: ${code}`);
  }
}

export class GitHubCheckRunClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: URL;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubCheckRunClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = requireOrigin(options.apiBaseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error("GitHub Check Run timeout is invalid");
    }
  }

  async create(input: GitHubCheckRunRequest): Promise<GitHubCheckRunRecord> {
    validateRequest(input);
    return this.requestRecord(
      input,
      `/repos/${repositoryPath(input.repositoryFullName)}/check-runs`,
      "POST",
      requestBody(input),
    );
  }

  async update(
    input: GitHubCheckRunRequest & { checkRunId: string },
  ): Promise<GitHubCheckRunRecord> {
    validateRequest(input);
    validateCheckRunId(input.checkRunId);
    return this.requestRecord(
      input,
      `/repos/${repositoryPath(input.repositoryFullName)}/check-runs/${encodeURIComponent(input.checkRunId)}`,
      "PATCH",
      requestBody(input),
    );
  }

  async list(input: {
    installationId: string;
    repositoryFullName: string;
    headSha: string;
    name: string;
  }): Promise<GitHubCheckRunRecord[]> {
    validateInstallationId(input.installationId);
    validateRepository(input.repositoryFullName);
    validateCommitSha(input.headSha);
    if (input.name.trim().length === 0 || input.name.length > 100) {
      throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
    }
    const payload = await this.requestJson(
      input,
      `/repos/${repositoryPath(input.repositoryFullName)}/commits/${encodeURIComponent(input.headSha)}/check-runs?check_name=${encodeURIComponent(input.name)}&per_page=100`,
      "GET",
    );
    if (!isRecord(payload) || !Array.isArray(payload.check_runs)) {
      throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, 200);
    }
    return payload.check_runs.map(parseCheckRun);
  }

  private async requestRecord(
    input: GitHubCheckRunRequest,
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ): Promise<GitHubCheckRunRecord> {
    const payload = await this.requestJson(input, path, method, body);
    return parseCheckRun(payload);
  }

  private async requestJson(
    input: { installationId: string },
    path: string,
    method: "GET" | "POST" | "PATCH",
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let token: string;
    try {
      token = await this.options.tokenProvider(input.installationId);
    } catch (error) {
      throw new GitHubCheckRunError(
        "CHECKS_TOKEN_FAILURE",
        isRecord(error) && error.retryable === true,
        503,
      );
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new GitHubCheckRunError("CHECKS_TOKEN_FAILURE", false, 502);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.apiBaseUrl), {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": API_VERSION,
          "user-agent": "PreviewForge/1.0",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GitHubCheckRunError("CHECKS_UPSTREAM_FAILURE", true, 503);
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      await consumeResponse(response);
      throw mapResponseError(response.status, response.headers);
    }
    if (!contentType.includes("json")) {
      await consumeResponse(response);
      throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubCheckRunError(
        "CHECKS_INVALID_RESPONSE",
        response.status >= 500,
        response.status,
      );
    }
  }
}

function requestBody(input: GitHubCheckRunRequest): Record<string, unknown> {
  const output = {
    title: input.title,
    summary: input.summary,
  };
  const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (bytes > MAX_OUTPUT_BYTES) throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
  return {
    name: input.name,
    head_sha: input.headSha,
    external_id: input.externalId,
    status: input.status,
    ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
    ...(input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl }),
    output,
  };
}

function parseCheckRun(value: unknown): GitHubCheckRunRecord {
  if (!isRecord(value)) throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, 200);
  const id = normalizeCheckRunId(value.id);
  const status = parseOptionalStatus(value.status);
  const conclusion = parseOptionalConclusion(value.conclusion);
  return {
    id,
    externalId:
      value.external_id === null || typeof value.external_id === "string"
        ? value.external_id
        : null,
    status,
    conclusion,
  };
}

function parseOptionalStatus(value: unknown): CheckRunStatus | null {
  if (value === null || value === undefined) return null;
  if (value === "queued" || value === "in_progress" || value === "completed") return value;
  throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, 200);
}

function parseOptionalConclusion(value: unknown): CheckRunConclusion | null {
  if (value === null || value === undefined) return null;
  if (value === "success" || value === "failure" || value === "neutral" || value === "cancelled")
    return value;
  return null;
}

function validateRequest(input: GitHubCheckRunRequest): void {
  validateInstallationId(input.installationId);
  validateRepository(input.repositoryFullName);
  validateCommitSha(input.headSha);
  if (input.name.trim().length === 0 || input.name.length > 100) {
    throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
  }
  if (input.externalId.length === 0 || input.externalId.length > 100) {
    throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
  }
  if (input.status === "completed" && input.conclusion === undefined) {
    throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
  }
  if (input.status !== "completed" && input.conclusion !== undefined) {
    throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
  }
}

function validateInstallationId(value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
}

function validateRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
  }
}

function validateCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
}

function validateCheckRunId(value: string): void {
  if (!/^[1-9][0-9]{0,20}$/.test(value))
    throw new GitHubCheckRunError("CHECKS_INPUT_INVALID", false);
}

function normalizeCheckRunId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,20}$/.test(value)) return value;
  throw new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, 200);
}

function repositoryPath(value: string): string {
  const [owner, repository] = value.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repository ?? "")}`;
}

function requireOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error();
    }
    return new URL(`${url.origin}/`);
  } catch {
    throw new Error("Invalid GitHub Check Run API origin");
  }
}

function mapResponseError(status: number, headers: Headers): GitHubCheckRunError {
  if (status === 401) return new GitHubCheckRunError("CHECKS_UNAUTHORIZED", false, status);
  if (status === 403) {
    const rateLimited = headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after");
    return new GitHubCheckRunError(
      rateLimited ? "CHECKS_RATE_LIMITED" : "CHECKS_FORBIDDEN",
      rateLimited,
      status,
    );
  }
  if (status === 404) return new GitHubCheckRunError("CHECKS_NOT_FOUND", false, status);
  if (status === 429) return new GitHubCheckRunError("CHECKS_RATE_LIMITED", true, status);
  if (status === 408 || status >= 500)
    return new GitHubCheckRunError("CHECKS_UPSTREAM_FAILURE", true, status);
  return new GitHubCheckRunError("CHECKS_INVALID_RESPONSE", false, status);
}

async function consumeResponse(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The upstream body is intentionally discarded and never enters an error.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
