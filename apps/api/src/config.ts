import { decodeCredentialEncryptionKey } from "@previewforge/security";
import { z } from "zod";

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_OAUTH_BASE_URL = "https://github.com";

const portSchema = z
  .string()
  .regex(/^\d+$/, "must contain only digits")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65_535));

const environmentSchema = z.object({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: portSchema.default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const positiveSecondsSchema = z
  .string()
  .regex(/^\d+$/, "must contain only digits")
  .transform(Number)
  .pipe(z.number().int().positive());

const sessionTtlSchema = positiveSecondsSchema.pipe(z.number().max(31 * 24 * 60 * 60));
const oauthStateTtlSchema = positiveSecondsSchema.pipe(z.number().max(15 * 60));

const databaseUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "postgres:" || url.protocol === "postgresql:";
    } catch {
      return false;
    }
  }, "must be a PostgreSQL connection URL");

const publicBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must use HTTP or HTTPS");

const githubOriginSchema = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        (url.pathname === "" || url.pathname === "/") &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "must be an HTTP(S) origin without credentials or a path")
  .transform((value) => new URL(value).origin);

export type ApiConfig = {
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl?: string;
  github?: GitHubConfig;
  encryptionKey?: Buffer;
  publicBaseUrl?: string;
  sessionTtlSeconds?: number;
  oauthStateTtlSeconds?: number;
};

export type GitHubConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  appSlug: string;
  apiBaseUrl: string;
  oauthBaseUrl: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const reasons = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid API configuration: ${reasons}`);
  }

  const m2Environment = parseM2Configuration(environment, result.data.NODE_ENV);

  return {
    host: result.data.API_HOST,
    logLevel: result.data.LOG_LEVEL,
    nodeEnv: result.data.NODE_ENV,
    port: result.data.API_PORT,
    ...m2Environment,
  };
}

type M2Environment = Pick<
  ApiConfig,
  | "databaseUrl"
  | "github"
  | "encryptionKey"
  | "publicBaseUrl"
  | "sessionTtlSeconds"
  | "oauthStateTtlSeconds"
>;

function parseM2Configuration(
  environment: NodeJS.ProcessEnv,
  nodeEnv: ApiConfig["nodeEnv"],
): M2Environment {
  const names = [
    "DATABASE_URL",
    "GITHUB_APP_ID",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_SLUG",
    "GITHUB_API_BASE_URL",
    "GITHUB_OAUTH_BASE_URL",
    "PUBLIC_BASE_URL",
    "ENCRYPTION_KEY",
    "SESSION_TTL_SECONDS",
    "OAUTH_STATE_TTL_SECONDS",
  ] as const;
  const hasM2Configuration = names.some((name) => environment[name] !== undefined);

  // Keeping the M1 empty-environment default is useful for the health-only API
  // and unit tests. Once one M2 setting is supplied, however, fail closed and
  // require the complete credential/database configuration.
  if (!hasM2Configuration) {
    if (nodeEnv === "production") {
      throw new Error(
        "Invalid API configuration: complete M2 configuration is required in production",
      );
    }
    return {};
  }

  const parsed = z
    .object({
      DATABASE_URL: databaseUrlSchema,
      GITHUB_APP_ID: z.string().regex(/^\d+$/, "must contain only digits"),
      GITHUB_CLIENT_ID: z.string().min(1),
      GITHUB_CLIENT_SECRET: z.string().min(1),
      GITHUB_APP_PRIVATE_KEY: z.string().min(1),
      GITHUB_WEBHOOK_SECRET: z.string().min(1),
      GITHUB_APP_SLUG: z.string().regex(/^[a-zA-Z0-9-]+$/),
      GITHUB_API_BASE_URL: githubOriginSchema.default(DEFAULT_GITHUB_API_BASE_URL),
      GITHUB_OAUTH_BASE_URL: githubOriginSchema.default(DEFAULT_GITHUB_OAUTH_BASE_URL),
      PUBLIC_BASE_URL: publicBaseUrlSchema,
      ENCRYPTION_KEY: z.string().min(1),
      SESSION_TTL_SECONDS: sessionTtlSchema.default(2592000),
      OAUTH_STATE_TTL_SECONDS: oauthStateTtlSchema.default(600),
    })
    .safeParse(environment);

  if (!parsed.success) {
    const reasons = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API configuration: ${reasons}`);
  }

  let encryptionKey: Buffer;
  try {
    encryptionKey = decodeCredentialEncryptionKey(parsed.data.ENCRYPTION_KEY);
  } catch {
    throw new Error("Invalid API configuration: ENCRYPTION_KEY must decode to 32 bytes");
  }

  if (nodeEnv === "production" && !parsed.data.PUBLIC_BASE_URL.startsWith("https://")) {
    throw new Error("Invalid API configuration: PUBLIC_BASE_URL must use HTTPS in production");
  }
  if (
    nodeEnv === "production" &&
    ((environment.GITHUB_API_BASE_URL !== undefined &&
      parsed.data.GITHUB_API_BASE_URL !== DEFAULT_GITHUB_API_BASE_URL) ||
      (environment.GITHUB_OAUTH_BASE_URL !== undefined &&
        parsed.data.GITHUB_OAUTH_BASE_URL !== DEFAULT_GITHUB_OAUTH_BASE_URL))
  ) {
    throw new Error(
      "Invalid API configuration: GitHub endpoint overrides are not allowed in production",
    );
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    github: {
      appId: parsed.data.GITHUB_APP_ID,
      clientId: parsed.data.GITHUB_CLIENT_ID,
      clientSecret: parsed.data.GITHUB_CLIENT_SECRET,
      privateKey: parsed.data.GITHUB_APP_PRIVATE_KEY,
      webhookSecret: parsed.data.GITHUB_WEBHOOK_SECRET,
      appSlug: parsed.data.GITHUB_APP_SLUG,
      apiBaseUrl: parsed.data.GITHUB_API_BASE_URL,
      oauthBaseUrl: parsed.data.GITHUB_OAUTH_BASE_URL,
    },
    encryptionKey,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL.replace(/\/$/, ""),
    sessionTtlSeconds: parsed.data.SESSION_TTL_SECONDS,
    oauthStateTtlSeconds: parsed.data.OAUTH_STATE_TTL_SECONDS,
  };
}
