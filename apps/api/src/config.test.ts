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
});
