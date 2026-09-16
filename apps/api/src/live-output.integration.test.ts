import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createPrismaClient,
  DeploymentRepository,
  hashOpaqueValue,
  LogChunkRepository,
  type PrismaClient,
} from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "./application.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the M6 live output HTTP integration test");
}

describe("M6 live output HTTP SSE integration (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ownerSession = `m6-sse-owner-${suffix}`;
  const foreignSession = `m6-sse-foreign-${suffix}`;
  const ownerIds: string[] = [];
  const streamControllers: AbortController[] = [];
  let prisma: PrismaClient;
  let app: Awaited<ReturnType<typeof createApplication>>;
  let apiOrigin = "";
  let owner: Awaited<ReturnType<typeof seedOwner>>;
  let foreign: Awaited<ReturnType<typeof seedOwner>>;

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    owner = await seedOwner(prisma, ownerIds, ownerSession, suffix, "owner");
    foreign = await seedOwner(prisma, ownerIds, foreignSession, suffix, "foreign");

    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    app = await createApplication({
      host: "127.0.0.1",
      logLevel: "error",
      nodeEnv: "test",
      port: 0,
      databaseUrl,
      encryptionKey: Buffer.alloc(32, 13),
      publicBaseUrl: "http://previewforge.test",
      sessionTtlSeconds: 3600,
      oauthStateTtlSeconds: 600,
      github: {
        appId: "123",
        clientId: "client-id",
        clientSecret: "unused-test-client-secret",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret: "unused-test-webhook-secret",
        appSlug: "previewforge-test",
        apiBaseUrl: "http://127.0.0.1:9",
        oauthBaseUrl: "http://127.0.0.1:9",
      },
    });
    await app.listen(0, "127.0.0.1");
    apiOrigin = await app.getUrl();
  });

  afterAll(async () => {
    for (const controller of streamControllers) controller.abort();
    if (app) await app.close();
    if (prisma) {
      if (ownerIds.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: {
            aggregateId: { in: [owner?.deploymentId, foreign?.deploymentId].filter(isString) },
          },
        });
        await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
      }
      await prisma.$disconnect();
    }
  }, 30_000);

  it("authenticates, replays and resumes ordered logs, refreshes status, signals gaps, heartbeats, and closes", async () => {
    const logs = new LogChunkRepository(prisma);
    await appendLog(logs, owner, "first-retained-log");
    await appendLog(logs, owner, "second-replay-log");

    const unauthenticated = await fetch(eventsUrl(owner.deploymentId));
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", statusCode: 401 },
    });

    const absentId = randomUUID();
    const hiddenAndMissing = await Promise.all([
      request(eventsUrl(foreign.deploymentId), ownerSession),
      request(eventsUrl(absentId), ownerSession),
    ]);
    expect(hiddenAndMissing.map((response) => response.status)).toEqual([404, 404]);
    const errors = await Promise.all(hiddenAndMissing.map(async (response) => response.json()));
    const normalizedErrors = errors.map(({ error }: { error: Record<string, unknown> }) => {
      const { requestId: _requestId, ...stableError } = error;
      return stableError;
    });
    expect(normalizedErrors[0]).toEqual(normalizedErrors[1]);

    const firstConnection = trackStream();
    const firstResponse = await requestStream(owner.deploymentId, "1", firstConnection.signal);
    const firstReader = new SseReader(firstResponse);
    const initialStatus = await firstReader.nextEvent();
    expect(initialStatus.event).toBe("status");
    expect(parseData(initialStatus)).toMatchObject({ id: owner.deploymentId, status: "BUILDING" });
    const replayed = await firstReader.nextEvent();
    expect(replayed).toMatchObject({ event: "log", id: "2" });
    expect(parseData(replayed)).toMatchObject({ sequence: 2, text: "second-replay-log" });

    await appendLog(logs, owner, "live-log-after-connect");
    const transitioned = await new DeploymentRepository(prisma).transition({
      deploymentId: owner.deploymentId,
      expectedStatus: "BUILDING",
      to: "PUSHING",
      expectedDesiredSha: owner.commitSha,
    });
    expect(transitioned.applied).toBe(true);
    let sawLiveLog = false;
    let sawUpdatedStatus = false;
    const liveEvents = await firstReader.until((event) => {
      if (event.event === "log" && event.id === "3") sawLiveLog = true;
      if (event.event === "status" && parseData(event).status === "PUSHING")
        sawUpdatedStatus = true;
      return sawLiveLog && sawUpdatedStatus;
    }, 6_000);
    expect(liveEvents.some((event) => event.event === "log" && event.id === "3")).toBe(true);
    expect(
      liveEvents.some((event) => event.event === "status" && parseData(event).status === "PUSHING"),
    ).toBe(true);
    firstConnection.abort();

    const reconnectController = trackStream();
    const reconnectResponse = await requestStream(
      owner.deploymentId,
      "2",
      reconnectController.signal,
    );
    const reconnectReader = new SseReader(reconnectResponse);
    expect(parseData(await reconnectReader.nextEvent())).toMatchObject({ status: "PUSHING" });
    const resumed = await reconnectReader.nextEvent();
    expect(resumed).toMatchObject({ event: "log", id: "3" });
    expect(parseData(resumed).text).toBe("live-log-after-connect");
    await reconnectReader.cancel();

    await prisma.logChunk.deleteMany({ where: { deploymentId: owner.deploymentId, sequence: 1 } });
    const gapController = trackStream();
    const gapResponse = await requestStream(owner.deploymentId, "0", gapController.signal);
    const gapReader = new SseReader(gapResponse);
    expect(parseData(await gapReader.nextEvent())).toMatchObject({ status: "PUSHING" });
    const gap = await gapReader.nextEvent();
    expect(gap).toMatchObject({ event: "gap" });
    expect(parseData(gap)).toEqual({ resumeSequence: 2 });
    const resumedAtGap = await gapReader.nextEvent();
    expect(resumedAtGap).toMatchObject({ event: "log", id: "2" });

    const heartbeat = await gapReader.until((event) => event.event === "comment", 20_000);
    expect(heartbeat.some((event) => event.comment === "heartbeat")).toBe(true);
    await gapReader.cancel();
    gapController.abort();
  }, 45_000);

  function eventsUrl(deploymentId: string): string {
    return `${apiOrigin}/api/deployments/${deploymentId}/events`;
  }

  function trackStream(): AbortController {
    const controller = new AbortController();
    streamControllers.push(controller);
    return controller;
  }

  function request(path: string, session = ownerSession): Promise<Response> {
    return fetch(path, {
      headers: { cookie: `previewforge_session=${session}`, "x-request-id": "m6-live-output-test" },
    });
  }

  function requestStream(
    deploymentId: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return fetch(eventsUrl(deploymentId), {
      headers: {
        cookie: `previewforge_session=${ownerSession}`,
        "last-event-id": cursor,
        "x-request-id": "m6-live-output-stream-test",
      },
      signal,
    }).then((response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      return response;
    });
  }
});

async function seedOwner(
  prisma: PrismaClient,
  cleanupUserIds: string[],
  sessionToken: string,
  suffix: string,
  label: string,
) {
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const pullRequestId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  const commitSha = "a".repeat(40);
  cleanupUserIds.push(userId);
  await prisma.user.create({
    data: { id: userId, githubUserId: `m6-sse-${label}-${suffix}`, githubLogin: `m6-sse-${label}` },
  });
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashOpaqueValue(sessionToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Date.now()) + BigInt(cleanupUserIds.length),
      accountLogin: `m6-sse-${label}`,
      accountType: "User",
      encryptedPrivateKey: `must-not-return-${label}-ciphertext`,
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      repositoryFullName: `integration/m6-sse-${label}`,
      dockerfilePath: "Dockerfile",
      containerPort: 3000,
      healthPath: "/health",
    },
  });
  await prisma.pullRequest.create({
    data: {
      id: pullRequestId,
      projectId,
      number: label === "owner" ? 42 : 43,
      title: `M6 SSE ${label} fixture`,
      headSha: commitSha,
      state: "OPEN",
    },
  });
  await prisma.previewEnvironment.create({
    data: {
      id: environmentId,
      projectId,
      pullRequestId,
      previewKey: `m6-sse-${label}-${suffix}`,
      desiredCommitSha: commitSha,
      status: "ACTIVE",
    },
  });
  await prisma.deployment.create({
    data: { id: deploymentId, environmentId, attempt: 1, commitSha, status: "BUILDING" },
  });
  return { userId, projectId, deploymentId, commitSha };
}

async function appendLog(
  logs: LogChunkRepository,
  owner: { deploymentId: string; commitSha: string },
  text: string,
): Promise<void> {
  const appended = await logs.append({
    deploymentId: owner.deploymentId,
    desiredSha: owner.commitSha,
    stage: "BUILDING",
    stream: "stdout",
    text,
  });
  expect(appended).not.toBeNull();
}

type SseEvent = { event: string; id?: string; data?: string; comment?: string };

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly events: SseEvent[] = [];
  private readonly waiters: Array<{
    resolve: (event: SseEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private done = false;
  private failure: Error | undefined;

  constructor(response: Response) {
    if (!response.body) throw new Error("SSE response has no readable body");
    this.reader = response.body.getReader();
    void this.pump();
  }

  async nextEvent(timeoutMs = 5_000): Promise<SseEvent> {
    const queued = this.events.shift();
    if (queued) return queued;
    if (this.done) throw this.failure ?? new Error("SSE stream ended before the expected event");
    return new Promise<SseEvent>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for an SSE event`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async until(predicate: (event: SseEvent) => boolean, timeoutMs: number): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs;
    const matched: SseEvent[] = [];
    while (Date.now() < deadline) {
      const event = await this.nextEvent(Math.max(1, deadline - Date.now()));
      matched.push(event);
      if (predicate(event)) return matched;
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for an SSE event`);
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }

  private async pump(): Promise<void> {
    try {
      while (true) {
        const next = await this.reader.read();
        if (next.done) break;
        this.buffer += this.decoder.decode(next.value, { stream: true });
        this.drainFrames();
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error("SSE stream read failed");
    } finally {
      this.done = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(this.failure ?? new Error("SSE stream ended before the expected event"));
      }
    }
  }

  private drainFrames(): void {
    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (!frame) continue;
      const event = parseFrame(frame);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      } else {
        this.events.push(event);
      }
    }
  }
}

function parseFrame(frame: string): SseEvent {
  const event: SseEvent = { event: "message" };
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith(":")) {
      event.event = "comment";
      event.comment = line.slice(1).trim();
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") event.event = value;
    if (field === "id") event.id = value;
    if (field === "data") data.push(value);
  }
  if (data.length > 0) event.data = data.join("\n");
  return event;
}

function parseData(event: SseEvent): Record<string, unknown> {
  if (!event.data) throw new Error(`SSE ${event.event} event has no data payload`);
  return JSON.parse(event.data) as Record<string, unknown>;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
