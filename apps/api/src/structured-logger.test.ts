import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredLogger } from "./structured-logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StructuredLogger", () => {
  it("emits event attributes as top-level JSON fields", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new StructuredLogger("info");

    logger.event("info", "http.request.completed", {
      durationMs: 12.5,
      method: "GET",
      path: "/health",
      requestId: "req-1",
      statusCode: 200,
    });

    const record = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      durationMs: 12.5,
      event: "http.request.completed",
      level: "info",
      method: "GET",
      path: "/health",
      requestId: "req-1",
      statusCode: 200,
    });
  });

  it("does not serialize unprovided request secrets", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new StructuredLogger("info");

    logger.event("info", "http.request.completed", {
      method: "POST",
      path: "/api/projects",
      requestId: "req-2",
      statusCode: 201,
    });

    expect(String(write.mock.calls[0]?.[0])).not.toContain("authorization");
    expect(String(write.mock.calls[0]?.[0])).not.toContain("cookie");
  });
});
