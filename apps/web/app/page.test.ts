import { describe, expect, it } from "vitest";
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
});
