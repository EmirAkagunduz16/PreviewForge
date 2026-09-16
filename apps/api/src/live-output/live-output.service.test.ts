import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LogChunkValidationError } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import { LiveOutputService } from "./live-output.service.js";
import type {
  LiveOutputConnection,
  LiveOutputDashboardPort,
  LiveOutputLogPage,
  LiveOutputLogPort,
} from "./live-output.types.js";

const deploymentId = "123e4567-e89b-42d3-a456-426614174000";

describe("LiveOutputService", () => {
  it("authenticates and hides absent/foreign deployments before opening the SSE response", async () => {
    const connection = new FakeConnection();
    const dashboard = { findDeployment: vi.fn(async () => null) };
    const logs = { readPage: vi.fn(async () => emptyPage()) };
    const service = new LiveOutputService(
      { authenticate: vi.fn(async () => ({ userId: "owner" })) },
      dashboard,
      logs,
    );

    await expect(
      service.stream("session", deploymentId, undefined, connection),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.stream("session", "not-a-uuid", undefined, connection),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.stream("session", deploymentId, "1.5", connection)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(connection.started).toBe(false);
    expect(logs.readPage).not.toHaveBeenCalled();
  });

  it("replays a retention gap, refreshes PostgreSQL status/logs, heartbeats, and cleans up on disconnect", async () => {
    const connection = new FakeConnection();
    let statusReads = 0;
    const dashboard: LiveOutputDashboardPort = {
      findDeployment: vi.fn(async () => {
        statusReads += 1;
        return statusReads === 1
          ? { id: deploymentId, attempt: 1, status: "BUILDING", ownerId: "must-not-leak" }
          : {
              id: deploymentId,
              attempt: 1,
              status: "READY",
              updatedAt: "2026-09-16T00:00:00.000Z",
              ownerId: "must-not-leak",
            };
      }),
    };
    const logReads: number[] = [];
    const logs: LiveOutputLogPort = {
      readPage: async (_owner, _deployment, options) => {
        logReads.push(options.after);
        if (options.after === 0) {
          return {
            kind: "found",
            gap: { resumeSequence: 4 },
            nextSequence: 6,
            hasMore: false,
            chunks: [chunk(4, "retained-4"), chunk(5, "retained-5")],
          };
        }
        if (options.after === 5) {
          return {
            kind: "found",
            gap: null,
            nextSequence: 7,
            hasMore: false,
            chunks: [chunk(6, "live-6")],
          };
        }
        return emptyPage(7);
      },
    };
    const service = new LiveOutputService(
      { authenticate: vi.fn(async () => ({ userId: "owner" })) },
      dashboard,
      logs,
      { pollIntervalMs: 20, heartbeatIntervalMs: 5 },
    );

    const running = service.stream("session", deploymentId, undefined, connection);
    await waitFor(
      () =>
        connection.frames.some((frame) => frame.includes(": heartbeat")) &&
        connection.frames.some((frame) => frame.includes('"status":"READY"')) &&
        connection.frames.some((frame) => frame.includes("id: 6\nevent: log")),
    );
    connection.close();
    await running;

    expect(connection.frames[0]).toContain("event: status");
    expect(connection.frames[0]).toContain('"status":"BUILDING"');
    expect(connection.frames[0]).not.toContain("ownerId");
    expect(
      connection.frames.some((frame) => frame.includes('event: gap\ndata: {"resumeSequence":4}')),
    ).toBe(true);
    expect(
      connection.frames.findIndex((frame) => frame.includes("id: 4\nevent: log")),
    ).toBeGreaterThan(connection.frames.findIndex((frame) => frame.includes("event: gap")));
    expect(connection.frames.some((frame) => frame.includes("id: 6\nevent: log"))).toBe(true);
    expect(logReads).toContain(5);
    expect(statusReads).toBeGreaterThan(1);
    expect(connection.ended).toBe(1);

    const frameCount = connection.frames.length;
    const readCount = logReads.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(connection.frames).toHaveLength(frameCount);
    expect(logReads).toHaveLength(readCount);
  });

  it("rejects a cursor beyond the durable deployment high-water before SSE headers", async () => {
    const connection = new FakeConnection();
    const invalidLogs: LiveOutputLogPort = {
      readPage: vi.fn(async () => {
        throw new LogChunkValidationError();
      }),
    };
    const invalidService = new LiveOutputService(
      { authenticate: vi.fn(async () => ({ userId: "owner" })) },
      { findDeployment: vi.fn(async () => ({ id: deploymentId, status: "READY" })) },
      invalidLogs,
    );
    await expect(
      invalidService.stream("session", deploymentId, "9", connection),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(connection.started).toBe(false);
  });

  it("uses a numeric Last-Event-ID as the durable replay boundary", async () => {
    const connection = new ClosingConnection();
    const readPage = vi.fn(
      async (_owner: string, _deployment: string, _options: { after: number }) => ({
        kind: "found" as const,
        chunks: [chunk(9, "resumed")],
        gap: null,
        nextSequence: 10,
        hasMore: false,
      }),
    );
    const service = new LiveOutputService(
      { authenticate: vi.fn(async () => ({ userId: "owner" })) },
      { findDeployment: vi.fn(async () => ({ id: deploymentId, status: "BUILDING" })) },
      { readPage },
    );

    await service.stream("session", deploymentId, "8", connection);

    expect(readPage).toHaveBeenCalledWith("owner", deploymentId, { after: 8, limit: 100 });
    expect(connection.frames.some((frame) => frame.includes("id: 9\nevent: log"))).toBe(true);
    expect(connection.ended).toBe(1);
  });
});

class FakeConnection implements LiveOutputConnection {
  frames: string[] = [];
  started = false;
  ended = 0;
  private closeCallback: (() => void) | undefined;

  start(): void {
    this.started = true;
  }

  send(frame: string): void {
    this.frames.push(frame);
  }

  onClose(callback: () => void): () => void {
    this.closeCallback = callback;
    return () => {
      this.closeCallback = undefined;
    };
  }

  end(): void {
    this.ended += 1;
  }

  close(): void {
    this.closeCallback?.();
  }
}

class ClosingConnection extends FakeConnection {
  override start(): void {
    super.start();
    this.close();
  }
}

function chunk(sequence: number, text: string) {
  return { sequence, stage: "BUILDING", stream: "stdout", text, createdAt: new Date(0) };
}

function emptyPage(nextSequence = 1): LiveOutputLogPage {
  return { kind: "found", chunks: [], gap: null, nextSequence, hasMore: false };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("Timed out waiting for SSE test condition");
}
