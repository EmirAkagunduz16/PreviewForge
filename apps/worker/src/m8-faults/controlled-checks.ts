import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type ControlledCheckRunServer = {
  origin: string;
  rawRequestBodies: string[];
  authorizationHeaders: string[];
  created: Array<{ id: string; externalId: string; status: string; conclusion: string | null }>;
  updated: Array<{ id: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
};

export async function startControlledCheckRunServer(): Promise<ControlledCheckRunServer> {
  const rawRequestBodies: string[] = [];
  const authorizationHeaders: string[] = [];
  const created: ControlledCheckRunServer["created"] = [];
  const updated: ControlledCheckRunServer["updated"] = [];
  let loseNextCreateResponse = true;
  let nextId = 5_800_008;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("M8 Check Run fixture did not bind");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    rawRequestBodies,
    authorizationHeaders,
    created,
    updated,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://m8-checks.fixture");
    if (request.headers.authorization !== undefined) {
      authorizationHeaders.push(request.headers.authorization);
    }

    if (request.method === "GET" && url.pathname.includes("/check-runs")) {
      json(response, 200, {
        check_runs: created.map((run) => ({
          id: run.id,
          external_id: run.externalId,
          status: run.status,
          conclusion: run.conclusion,
        })),
      });
      return;
    }

    const checkRunMatch = /\/check-runs\/([0-9]+)$/u.exec(url.pathname);
    if (request.method === "PATCH" && checkRunMatch !== null) {
      const body = await readJson(request);
      rawRequestBodies.push(JSON.stringify(body));
      const id = checkRunMatch[1];
      if (id === undefined) {
        json(response, 404, { message: "not found" });
        return;
      }
      const run = created.find((candidate) => candidate.id === id);
      if (run === undefined) {
        json(response, 404, { message: "not found" });
        return;
      }
      run.status = typeof body.status === "string" ? body.status : run.status;
      run.conclusion = typeof body.conclusion === "string" ? body.conclusion : run.conclusion;
      updated.push({ id, body });
      json(response, 200, {
        id,
        external_id: run.externalId,
        status: run.status,
        conclusion: run.conclusion,
      });
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/check-runs")) {
      const body = await readJson(request);
      rawRequestBodies.push(JSON.stringify(body));
      const run = {
        id: String(nextId++),
        externalId: typeof body.external_id === "string" ? body.external_id : "",
        status: typeof body.status === "string" ? body.status : "queued",
        conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
      };
      created.push(run);
      if (loseNextCreateResponse) {
        loseNextCreateResponse = false;
        request.socket?.destroy();
        return;
      }
      json(response, 201, {
        id: run.id,
        external_id: run.externalId,
        status: run.status,
        conclusion: run.conclusion,
      });
      return;
    }

    json(response, 404, { message: "not found" });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("M8 Check Run fixture received a non-object body");
  }
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
