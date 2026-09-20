import { describe, expect, it } from "vitest";
import { loadPreviewUrlConfig, previewHostname, previewUrl } from "../src/preview-url.js";

const environmentId = "22222222-2222-4222-8222-222222222222";

describe("preview URL contract", () => {
  it("keeps the HTTPRoute hostname and adds only the local Gateway port", () => {
    const config = loadPreviewUrlConfig(
      {
        PREVIEW_BASE_DOMAIN: "preview.localhost",
        PREVIEW_URL_SCHEME: "http",
        PREVIEWFORGE_GATEWAY_LOCAL_PORT: "18080",
      },
      "development",
    );
    expect(config).toEqual({ baseDomain: "preview.localhost", scheme: "http", localPort: 18080 });
    expect(previewHostname(environmentId, config.baseDomain)).toBe(
      "preview-22222222-2222-4222-8222-222222222222.preview.localhost",
    );
    expect(previewUrl(environmentId, config)).toBe(
      "http://preview-22222222-2222-4222-8222-222222222222.preview.localhost:18080/",
    );
  });

  it("defaults local URLs to the resolvable localhost domain", () => {
    expect(loadPreviewUrlConfig({}, "test")).toEqual({
      baseDomain: "preview.localhost",
      scheme: "http",
    });
  });

  it.each(["0", "65536", "12x", "http://18080"])("rejects malformed local port %s", (localPort) => {
    expect(() =>
      loadPreviewUrlConfig({ PREVIEWFORGE_GATEWAY_LOCAL_PORT: localPort }, "development"),
    ).toThrow("PREVIEWFORGE_GATEWAY_LOCAL_PORT");
  });

  it("rejects a local port with HTTPS because the local forward is HTTP", () => {
    expect(() =>
      loadPreviewUrlConfig(
        {
          PREVIEW_BASE_DOMAIN: "preview.example.test",
          PREVIEW_URL_SCHEME: "https",
          PREVIEWFORGE_GATEWAY_LOCAL_PORT: "18080",
        },
        "development",
      ),
    ).toThrow("requires HTTP");
  });

  it("requires a public HTTPS, portless domain in production", () => {
    expect(() =>
      loadPreviewUrlConfig({ PREVIEW_BASE_DOMAIN: "preview.localhost" }, "production"),
    ).toThrow("public HTTPS domain");
    expect(() =>
      loadPreviewUrlConfig(
        { PREVIEW_BASE_DOMAIN: "preview.example.test", PREVIEWFORGE_GATEWAY_LOCAL_PORT: "443" },
        "production",
      ),
    ).toThrow("without a local port");
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

  it("rejects credentials and malformed authority values", () => {
    expect(() =>
      loadPreviewUrlConfig({ PREVIEW_BASE_DOMAIN: "user:pass@example.test" }, "development"),
    ).toThrow("PREVIEW_BASE_DOMAIN");
    expect(() => previewHostname(environmentId, "preview..localhost")).toThrow(
      "PREVIEW_BASE_DOMAIN",
    );
    expect(() => previewHostname("not-a-uuid", "preview.localhost")).toThrow("environmentId");
  });

  it("rejects a base domain that would exceed the generated hostname limit", () => {
    const tooLongBaseDomain = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(17)].join(
      ".",
    );
    expect(() =>
      loadPreviewUrlConfig({ PREVIEW_BASE_DOMAIN: tooLongBaseDomain }, "development"),
    ).toThrow("PREVIEW_BASE_DOMAIN");
  });
});
