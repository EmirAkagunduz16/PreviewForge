import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("provides safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      logLevel: "info",
      nodeEnv: "development",
      port: 4000,
    });
  });

  it.each(["0", "65536", "not-a-port", ""])("rejects an invalid API_PORT value: %s", (port) => {
    expect(() => loadConfig({ API_PORT: port })).toThrow("Invalid API configuration");
  });

  it("does not include environment values in validation failures", () => {
    const secretLikeValue = "do-not-echo-this";

    expect(() => loadConfig({ NODE_ENV: secretLikeValue })).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secretLikeValue) }),
    );
  });

  it("validates and normalizes the complete M2 configuration without echoing secrets", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://previewforge:previewforge@localhost:55432/previewforge",
      GITHUB_APP_ID: "12345",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      GITHUB_APP_SLUG: "previewforge",
      GITHUB_API_BASE_URL: "http://127.0.0.1:43123/",
      GITHUB_OAUTH_BASE_URL: "http://127.0.0.1:43123",
      PUBLIC_BASE_URL: "http://localhost:4000/",
      ENCRYPTION_KEY: "00".repeat(32),
      SESSION_TTL_SECONDS: "3600",
      OAUTH_STATE_TTL_SECONDS: "600",
    });

    expect(config.databaseUrl).toBe(
      "postgresql://previewforge:previewforge@localhost:55432/previewforge",
    );
    expect(config.github).toEqual({
      appId: "12345",
      clientId: "client-id",
      clientSecret: "client-secret",
      privateKey: "private-key",
      webhookSecret: "webhook-secret",
      appSlug: "previewforge",
      apiBaseUrl: "http://127.0.0.1:43123",
      oauthBaseUrl: "http://127.0.0.1:43123",
    });
    expect(config.encryptionKey).toEqual(Buffer.alloc(32));
    expect(config.publicBaseUrl).toBe("http://localhost:4000");
    expect(config.sessionTtlSeconds).toBe(3600);
    expect(config.oauthStateTtlSeconds).toBe(600);
    expect(config.previewTtlSeconds).toBe(86_400);
  });

  it("accepts a bounded preview TTL and rejects values above 31 days", () => {
    const base = {
      NODE_ENV: "test" as const,
      DATABASE_URL: "postgresql://localhost/db",
      GITHUB_APP_ID: "12345",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      GITHUB_APP_SLUG: "previewforge",
      PUBLIC_BASE_URL: "http://localhost:4000",
      ENCRYPTION_KEY: "00".repeat(32),
    };
    expect(loadConfig({ ...base, PREVIEW_TTL_SECONDS: "60" }).previewTtlSeconds).toBe(60);
    expect(() =>
      loadConfig({ ...base, PREVIEW_TTL_SECONDS: String(31 * 24 * 60 * 60 + 1) }),
    ).toThrow("Invalid API configuration");
  });

  it("rejects a partial M2 configuration without revealing its values", () => {
    const secret = "super-secret-client-value";
    expect(() =>
      loadConfig({ DATABASE_URL: "postgresql://localhost/db", GITHUB_CLIENT_SECRET: secret }),
    ).toThrow(expect.not.objectContaining({ message: expect.stringContaining(secret) }));
  });

  it("fails closed for production without M2 configuration or HTTPS", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("complete M2 configuration");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost/db",
        GITHUB_APP_ID: "12345",
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
        GITHUB_APP_PRIVATE_KEY: "private-key",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
        GITHUB_APP_SLUG: "previewforge",
        GITHUB_API_BASE_URL: "http://127.0.0.1:43123",
        PUBLIC_BASE_URL: "http://localhost:4000",
        ENCRYPTION_KEY: "00".repeat(32),
      }),
    ).toThrow("PUBLIC_BASE_URL must use HTTPS");
  });

  it("rejects non-origin GitHub endpoint overrides and production fakes", () => {
    const base = {
      NODE_ENV: "test" as const,
      DATABASE_URL: "postgresql://localhost/db",
      GITHUB_APP_ID: "12345",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      GITHUB_APP_SLUG: "previewforge",
      PUBLIC_BASE_URL: "http://localhost:4000",
      ENCRYPTION_KEY: "00".repeat(32),
    };
    expect(() =>
      loadConfig({ ...base, GITHUB_API_BASE_URL: "https://user:pass@example.test/api" }),
    ).toThrow("Invalid API configuration");
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://localhost:4000",
        GITHUB_API_BASE_URL: "http://fake.test",
      }),
    ).toThrow("GitHub endpoint overrides are not allowed in production");
  });
});
