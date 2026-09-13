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
