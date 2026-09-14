import { randomUUID, sign } from "node:crypto";

export type InstallationTokenProviderOptions = {
  appId: string;
  privateKey: string;
  apiBaseUrl: string;
  fetch?: typeof fetch;
};

export class InstallationTokenError extends Error {
  override readonly name = "InstallationTokenError";

  constructor(readonly retryable: boolean) {
    super("GitHub installation token could not be acquired");
  }
}

/** Mints a short-lived App JWT and exchanges it for an installation token. */
export class GitHubInstallationTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: URL;

  constructor(private readonly options: InstallationTokenProviderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = requireOrigin(options.apiBaseUrl);
    if (!/^[1-9][0-9]*$/.test(options.appId)) throw new Error("Invalid GitHub App ID");
    if (options.privateKey.trim().length === 0)
      throw new Error("GitHub App private key is required");
  }

  async getToken(installationId: string): Promise<string> {
    if (!/^[1-9][0-9]*$/.test(installationId)) throw new InstallationTokenError(false);
    const jwt = createAppJwt(this.options.appId, this.options.privateKey);
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(
          `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
          this.apiBaseUrl,
        ),
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "PreviewForge/1.0",
          },
        },
      );
    } catch {
      throw new InstallationTokenError(true);
    }
    if (!response.ok)
      throw new InstallationTokenError(response.status === 429 || response.status >= 500);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new InstallationTokenError(false);
    }
    if (!isRecord(payload) || typeof payload.token !== "string" || payload.token.length === 0) {
      throw new InstallationTokenError(false);
    }
    return payload.token;
  }
}

function createAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1_000) - 30;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId, jti: randomUUID() }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function requireOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      throw new Error();
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new Error("Invalid GitHub API origin");
  }
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
