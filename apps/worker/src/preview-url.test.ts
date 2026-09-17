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

  it("defaults local workers to the existing previewforge.local route", () => {
    expect(loadPreviewUrlConfig({}, "test")).toEqual({
      baseDomain: "previewforge.local",
      scheme: "http",
    });
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
