import { describe, expect, it } from "vitest";
import { loadPreviewUrlConfig, previewHostname, previewUrl } from "./preview-url.js";

const environmentId = "22222222-2222-4222-8222-222222222222";

describe("preview URL configuration", () => {
  it("uses one hostname contract for Gateway and user-facing URLs", () => {
    const config = loadPreviewUrlConfig(
      { PREVIEW_BASE_DOMAIN: "preview.example.test", PREVIEW_URL_SCHEME: "https" },
      "test",
    );
    expect(previewHostname(environmentId, config.baseDomain)).toBe(
      "preview-22222222-2222-4222-8222-222222222222.preview.example.test",
    );
    expect(previewUrl(environmentId, config)).toBe(
      "https://preview-22222222-2222-4222-8222-222222222222.preview.example.test/",
    );
  });

  it("defaults local workers to the resolvable localhost route", () => {
    expect(loadPreviewUrlConfig({}, "test")).toEqual({
      baseDomain: "preview.localhost",
      scheme: "http",
    });
  });

  it("adds the configured local Gateway port only to the user-facing URL", () => {
    const config = loadPreviewUrlConfig(
      { PREVIEW_BASE_DOMAIN: "preview.localhost", PREVIEWFORGE_GATEWAY_LOCAL_PORT: "18080" },
      "development",
    );
    expect(config).toEqual({ baseDomain: "preview.localhost", scheme: "http", localPort: 18080 });
    expect(previewHostname(environmentId, config.baseDomain)).not.toContain(":18080");
    expect(previewUrl(environmentId, config)).toContain(":18080/");
  });

  it("requires a public HTTPS domain in production", () => {
    expect(() =>
      loadPreviewUrlConfig({ PREVIEW_BASE_DOMAIN: "preview.localhost" }, "production"),
    ).toThrow("public HTTPS domain");
    expect(() =>
      loadPreviewUrlConfig(
        { PREVIEW_BASE_DOMAIN: "preview.example.test", PREVIEW_URL_SCHEME: "ftp" },
        "production",
      ),
    ).toThrow("PREVIEW_URL_SCHEME");
    expect(
      loadPreviewUrlConfig(
        { PREVIEW_BASE_DOMAIN: "preview.example.test", PREVIEW_URL_SCHEME: "https" },
        "production",
      ),
    ).toEqual({ baseDomain: "preview.example.test", scheme: "https" });
  });
});
