import { describe, expect, it } from "vitest";
import { isValidTraceparent, PreviewForgeTelemetry, parseTraceparent } from "../src/index.js";

describe("PreviewForge observability contract", () => {
  it("renders bounded Prometheus metrics and links child spans to a W3C parent", () => {
    const telemetry = new PreviewForgeTelemetry("previewforge-worker");
    const parent = telemetry.startSpan("http.server", undefined, { "http.method": "POST" });
    const child = telemetry.startSpan("kafka.consume", parent.context, {
      "messaging.system": "kafka",
      "messaging.destination": "previewforge.deployment-requests.v1",
    });
    child.end();
    parent.end();
    telemetry.metrics.increment("previewforge_kafka_messages_total", {
      topic: "previewforge.deployment-requests.v1",
      consumer: "m8-worker",
      outcome: "PROCESSED",
    });

    const traces = telemetry.getTraceRecords();
    expect(traces).toHaveLength(2);
    expect(traces.find((span) => span.name === "kafka.consume")?.parentSpanId).toBe(
      parent.context.spanId,
    );
    expect(telemetry.metrics.renderPrometheus()).toContain(
      'previewforge_kafka_messages_total{topic="previewforge.deployment-requests.v1",consumer="m8-worker",outcome="PROCESSED"} 1',
    );
    expect(telemetry.renderTraces()).toContain(parent.context.traceId);
  });

  it("rejects unbounded or sensitive observability data", () => {
    const telemetry = new PreviewForgeTelemetry("previewforge-api");
    expect(() =>
      telemetry.metrics.increment("previewforge_http_requests_total", {
        method: "GET",
        route: "/api/:id",
        status_code: 200,
        repository: "acme/store",
      }),
    ).toThrow("not declared");
    expect(() =>
      telemetry.startSpan("unsafe", undefined, { "http.route": "token=secret" }),
    ).toThrow("sensitive");
  });

  it("accepts only non-zero W3C traceparent identities", () => {
    const value = "00-11111111111111111111111111111111-2222222222222222-01";
    expect(isValidTraceparent(value)).toBe(true);
    expect(parseTraceparent(value)).toMatchObject({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
    });
    expect(isValidTraceparent("00-00000000000000000000000000000000-2222222222222222-01")).toBe(
      false,
    );
    expect(isValidTraceparent("not-a-traceparent")).toBe(false);
  });
});
