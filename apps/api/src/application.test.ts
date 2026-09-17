import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";

const openApplications: Array<Awaited<ReturnType<typeof createApplication>>> = [];

afterEach(async () => {
  await Promise.all(openApplications.splice(0).map((app) => app.close()));
});

describe("API runtime contract", () => {
  it("echoes a safe request ID on a healthy request", async () => {
    const app = await startTestApplication();
    const response = await fetch(`${await app.getUrl()}/health`, {
      headers: { "x-request-id": "test-request-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("test-request-1");
  });

  it("returns the shared error envelope and replaces unsafe request IDs", async () => {
    const app = await startTestApplication();
    const response = await fetch(`${await app.getUrl()}/api/not-found`, {
      headers: { "x-request-id": "unsafe!" },
    });
    const body = await response.json();
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(404);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId,
        statusCode: 404,
      },
    });
  });

  it("exposes local metrics and an HTTP trace with bounded route data", async () => {
    const app = await startTestApplication();
    const origin = await app.getUrl();
    const health = await fetch(`${origin}/health`);
    const metrics = await fetch(`${origin}/metrics`);
    const traces = await fetch(`${origin}/traces`);
    const traceBody = (await traces.json()) as {
      spans: Array<{ name: string; attributes: Record<string, unknown> }>;
    };

    expect(health.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/u);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    expect(await metrics.text()).toContain("previewforge_http_requests_total");
    expect(traceBody.spans.some((span) => span.name === "http.server")).toBe(true);
    expect(JSON.stringify(traceBody)).not.toContain("/health?secret");
  });
});

async function startTestApplication() {
  const app = await createApplication({
    host: "127.0.0.1",
    logLevel: "error",
    nodeEnv: "test",
    port: 0,
  });
  openApplications.push(app);
  await app.listen(0, "127.0.0.1");
  return app;
}
