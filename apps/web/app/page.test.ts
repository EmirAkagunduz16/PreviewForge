import { describe, expect, it } from "vitest";
import { ApiRequestError, importErrorMessage, userFacingApiError } from "./onboarding";
import { parseSse } from "./sse";

describe("dashboard SSE parser", () => {
  it("parses named JSON events without evaluating payloads", () => {
    expect(parseSse('event: log\ndata: {"text":"<script>"}')).toEqual({
      event: "log",
      data: '{"text":"<script>"}',
    });
  });

  it("ignores heartbeat comments and incomplete frames", () => {
    expect(parseSse(": heartbeat")).toBeNull();
    expect(parseSse("event: log")).toBeNull();
  });

  it("keeps onboarding errors actionable without exposing server details", () => {
    expect(
      importErrorMessage(new ApiRequestError(400, "DOCKERFILE_NOT_FOUND", "internal detail")),
    ).toBe("The Dockerfile path does not point to a file in this repository.");
    expect(
      userFacingApiError(
        new ApiRequestError(503, "UPSTREAM_FAILURE", "internal detail"),
        "fallback",
      ),
    ).toBe("PreviewForge API is unavailable. Check the local runtime.");
  });
});
