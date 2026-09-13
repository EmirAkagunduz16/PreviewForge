import { randomUUID, sign } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_OAUTH_BASE_URL = "https://github.com";
const API_VERSION = "2022-11-28";
const MAX_PAGES = 100;

export type GitHubFetch = typeof fetch;

export type GitHubClientOptions = {
  appId: string | number;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;
  oauthBaseUrl?: string;
  fetch?: GitHubFetch;
};

export type GitHubTokenResponse = {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
  expiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
  refreshTokenExpiresAt?: string;
};

export class GitHubApiError extends Error {
  override readonly name = "GitHubApiError";
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly code: GitHubErrorCode,
    retryable = status === 429 || status >= 500,
  ) {
    super("GitHub request failed");
    this.retryable = retryable;
  }
}

export type GitHubErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_failure"
  | "invalid_response"
  | "unsafe_pagination";

export type GitHubRepository = {
  id: string;
  fullName: string;
  name: string;
  ownerLogin?: string;
  private?: boolean;
  defaultBranch?: string;
  pull?: boolean;
};

export type GitHubUser = {
  id: string;
  login: string;
  name?: string | null;
};

export type GitHubInstallation = {
  id: string;
  accountLogin?: string;
  accountId?: string;
  accountType?: string;
};

export type GitHubContent = {
  type: string;
  path: string;
  sha?: string;
  size?: number;
  downloadUrl?: string | null;
};

export class GitHubClient {
  private readonly fetchImpl: GitHubFetch;
  private readonly apiBaseUrl: URL;
  private readonly oauthBaseUrl: URL;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = requireOriginUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.oauthBaseUrl = requireOriginUrl(options.oauthBaseUrl ?? DEFAULT_OAUTH_BASE_URL);
  }

  createAppJwt(now = Date.now()): string {
    return createGitHubAppJwt(this.options.appId, this.options.privateKey, now);
  }

  async exchangeUserCode(input: {
    code: string;
    redirectUri?: string;
    codeVerifier?: string;
  }): Promise<GitHubTokenResponse> {
    if (!this.options.clientId || !this.options.clientSecret) {
      throw new Error("GitHub OAuth client credentials are not configured");
    }
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code: input.code,
      ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    });
    const response = await this.request(this.oauthUrl("/login/oauth/access_token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      oauth: true,
    });
    return parseOAuthTokenResponse(response.json);
  }

  async createInstallationToken(
    installationId: string | number,
    appJwt = this.createAppJwt(),
  ): Promise<GitHubTokenResponse> {
    const id = normalizeGitHubId(installationId);
    const response = await this.request(
      this.apiUrl(`/app/installations/${encodeURIComponent(id)}/access_tokens`),
      { method: "POST", token: appJwt },
    );
    return parseInstallationTokenResponse(response.json);
  }

  async getCurrentUser(userToken: string): Promise<GitHubUser> {
    return parseUser(await this.requestJson("/user", { token: userToken }));
  }

  async getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
    return this.getCurrentUser(userToken);
  }

  async verifyUserInstallation(
    installationId: string | number,
    userToken: string,
  ): Promise<GitHubInstallation> {
    const id = normalizeGitHubId(installationId);
    const installation = parseInstallation(
      await this.requestJson(`/user/installations/${encodeURIComponent(id)}`, { token: userToken }),
    );
    if (installation.id !== id) throw new GitHubApiError(502, "invalid_response", false);
    return installation;
  }

  async verifyAppInstallation(
    installationId: string | number,
    appJwt = this.createAppJwt(),
  ): Promise<GitHubInstallation> {
    const id = normalizeGitHubId(installationId);
    const installation = parseInstallation(
      await this.requestJson(`/app/installations/${encodeURIComponent(id)}`, { token: appJwt }),
    );
    if (installation.id !== id) throw new GitHubApiError(502, "invalid_response", false);
    return installation;
  }

  async listUserRepositories(userToken: string): Promise<GitHubRepository[]> {
    const pages = await this.getPaginated<GitHubRepository>(
      "/user/repos?per_page=100&sort=updated",
      userToken,
      parseRepositoryPage,
    );
    return pages.flat();
  }

  async listInstallationRepositories(
    installationId: string | number,
    installationToken: string,
  ): Promise<GitHubRepository[]> {
    // The installation ID is intentionally checked even though GitHub's
    // endpoint derives it from the token; callers must not accidentally mix
    // identities at this boundary.
    normalizeGitHubId(installationId);
    const pages = await this.getPaginated<GitHubRepository>(
      "/installation/repositories?per_page=100",
      installationToken,
      parseRepositoryEnvelope,
    );
    return pages.flat();
  }

  async listUserInstallationRepositories(
    installationId: string | number,
    userToken: string,
  ): Promise<GitHubRepository[]> {
    const id = normalizeGitHubId(installationId);
    const pages = await this.getPaginated<GitHubRepository>(
      `/user/installations/${encodeURIComponent(id)}/repositories?per_page=100`,
      userToken,
      parseRepositoryEnvelope,
    );
    return pages.flat();
  }

  async getRepositoryContent(
    owner: string,
    repository: string,
    path: string,
    installationToken: string,
  ): Promise<GitHubContent | GitHubContent[]> {
    const pathSuffix = path
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => encodeURIComponent(part))
      .join("/");
    const payload = await this.requestJson<unknown>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${pathSuffix}`,
      { token: installationToken },
    );
    return parseContent(payload);
  }

  private async getPaginated<T>(
    path: string,
    token: string,
    parsePage: (value: unknown) => T[],
  ): Promise<T[][]> {
    const pages: T[][] = [];
    const seen = new Set<string>();
    let next: URL | undefined = this.apiUrl(path);
    for (let page = 0; page < MAX_PAGES && next; page += 1) {
      const key = next.toString();
      if (seen.has(key)) throw new GitHubApiError(502, "unsafe_pagination", false);
      seen.add(key);
      const response = await this.request(next, { token });
      const value = parsePage(response.json);
      pages.push(value);
      next = parseNextLink(response.headers.get("link"), this.apiBaseUrl);
    }
    if (next) throw new GitHubApiError(502, "unsafe_pagination", false);
    return pages;
  }

  private async requestJson<T>(path: string, options: RequestOptions): Promise<T> {
    return (await this.request(this.apiUrl(path), options)).json as T;
  }

  private async request(url: URL, options: RequestOptions): Promise<GitHubResponse> {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": "PreviewForge/1.0",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    });
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      throw new GitHubApiError(503, "upstream_failure");
    }
    let json: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        json = await response.json();
      } catch {
        throw new GitHubApiError(response.status, "invalid_response", response.status >= 500);
      }
    } else {
      // Consume the body without copying it into an error. Error payloads can
      // contain credentials or arbitrary repository-controlled text.
      await response.arrayBuffer();
    }
    if (!response.ok) {
      throw new GitHubApiError(response.status, errorCode(response.status));
    }
    return { headers: response.headers, json };
  }

  private apiUrl(path: string): URL {
    return new URL(path, this.apiBaseUrl);
  }

  private oauthUrl(path: string): URL {
    return new URL(path, this.oauthBaseUrl);
  }
}

export function createGitHubAppJwt(
  appId: string | number,
  privateKey: string,
  now = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const payload = {
    iat: issuedAt,
    exp: issuedAt + 600,
    iss: String(appId),
    jti: randomUUID(),
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const body = encode(payload);
  const signingInput = `${header}.${body}`;
  try {
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
      "base64url",
    );
    return `${signingInput}.${signature}`;
  } catch {
    throw new Error("Unable to create GitHub App authentication token");
  }
}

export function parseNextLink(value: string | null, allowedOrigin: URL): URL | undefined {
  if (!value) return undefined;
  const match = value
    .split(",")
    .map((part) => part.trim())
    .find((part) => /(?:^|;)\s*rel="?next"?(?:;|$)/i.test(part));
  if (!match) return undefined;
  const target = match.match(/^<([^>]+)>/u)?.[1];
  if (!target) throw new GitHubApiError(502, "unsafe_pagination", false);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new GitHubApiError(502, "unsafe_pagination", false);
  }
  if (
    url.origin !== allowedOrigin.origin ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new GitHubApiError(502, "unsafe_pagination", false);
  }
  return url;
}

type RequestOptions = {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  oauth?: boolean;
};

type GitHubResponse = { headers: Headers; json: unknown };

function requireOriginUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new Error("GitHub endpoint must be an HTTP origin");
  }
  return new URL(`${url.origin}/`);
}

function parseOAuthTokenResponse(value: unknown): GitHubTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length === 0
  ) {
    throw new GitHubApiError(502, "invalid_response", false);
  }
  return {
    accessToken: value.access_token,
    ...(typeof value.token_type === "string" ? { tokenType: value.token_type } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.expires_in === "number" ? { expiresIn: value.expires_in } : {}),
    ...(typeof value.expires_at === "string" ? { expiresAt: value.expires_at } : {}),
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.refresh_token_expires_in === "number"
      ? { refreshTokenExpiresIn: value.refresh_token_expires_in }
      : {}),
    ...(typeof value.refresh_token_expires_at === "string"
      ? { refreshTokenExpiresAt: value.refresh_token_expires_at }
      : {}),
  };
}

function parseInstallationTokenResponse(value: unknown): GitHubTokenResponse {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length === 0) {
    throw new GitHubApiError(502, "invalid_response", false);
  }
  return {
    accessToken: value.token,
    ...(typeof value.expires_at === "string" ? { expiresAt: value.expires_at } : {}),
  };
}

function parseRepositoryPage(value: unknown): GitHubRepository[] {
  if (!Array.isArray(value)) throw new GitHubApiError(502, "invalid_response", false);
  return value.map((item) => {
    if (
      !isRecord(item) ||
      (typeof item.id !== "number" && typeof item.id !== "string") ||
      typeof item.full_name !== "string" ||
      typeof item.name !== "string"
    ) {
      throw new GitHubApiError(502, "invalid_response", false);
    }
    const owner =
      isRecord(item.owner) && typeof item.owner.login === "string" ? item.owner.login : undefined;
    return {
      id: normalizeGitHubId(item.id),
      fullName: item.full_name,
      name: item.name,
      ...(owner ? { ownerLogin: owner } : {}),
      ...(typeof item.private === "boolean" ? { private: item.private } : {}),
      ...(typeof item.default_branch === "string" ? { defaultBranch: item.default_branch } : {}),
      ...(isRecord(item.permissions) && typeof item.permissions.pull === "boolean"
        ? { pull: item.permissions.pull }
        : {}),
    };
  });
}

function parseRepositoryEnvelope(value: unknown): GitHubRepository[] {
  if (!isRecord(value) || !Array.isArray(value.repositories)) {
    throw new GitHubApiError(502, "invalid_response", false);
  }
  return parseRepositoryPage(value.repositories);
}

function parseUser(value: unknown): GitHubUser {
  if (!isRecord(value) || typeof value.login !== "string") {
    throw new GitHubApiError(502, "invalid_response", false);
  }
  return {
    id: normalizeGitHubId(value.id),
    login: value.login,
    ...(value.name === null || typeof value.name === "string" ? { name: value.name } : {}),
  };
}

function parseInstallation(value: unknown): GitHubInstallation {
  if (!isRecord(value)) throw new GitHubApiError(502, "invalid_response", false);
  const account = isRecord(value.account) ? value.account : undefined;
  return {
    id: normalizeGitHubId(value.id),
    ...(account && typeof account.login === "string" ? { accountLogin: account.login } : {}),
    ...(account && account.id !== undefined ? { accountId: normalizeGitHubId(account.id) } : {}),
    ...(account && typeof account.type === "string" ? { accountType: account.type } : {}),
  };
}

function normalizeGitHubId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GitHubApiError(502, "invalid_response", false);
    }
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const normalized = BigInt(value).toString();
    if (normalized !== "0") return normalized;
  }
  throw new GitHubApiError(502, "invalid_response", false);
}

function parseContent(value: unknown): GitHubContent | GitHubContent[] {
  if (Array.isArray(value)) return value.map(parseContentItem);
  return parseContentItem(value);
}

function parseContentItem(value: unknown): GitHubContent {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.path !== "string") {
    throw new GitHubApiError(502, "invalid_response", false);
  }
  return {
    type: value.type,
    path: value.path,
    ...(typeof value.sha === "string" ? { sha: value.sha } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
    ...(value.download_url === null || typeof value.download_url === "string"
      ? { downloadUrl: value.download_url }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(status: number): GitHubErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_failure";
  return "bad_request";
}
