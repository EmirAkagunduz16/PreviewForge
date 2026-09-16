import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { LogChunkValidationError } from "@previewforge/database";
import type {
  LiveOutputAuthPort,
  LiveOutputConnection,
  LiveOutputDashboardPort,
  LiveOutputLogPage,
  LiveOutputLogPort,
} from "./live-output.types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LOG_SEQUENCE = 2_147_483_647;
const LOG_PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

@Injectable()
export class LiveOutputService {
  private readonly logger = new Logger(LiveOutputService.name);

  constructor(
    private readonly auth: LiveOutputAuthPort,
    private readonly dashboard: LiveOutputDashboardPort,
    private readonly logs: LiveOutputLogPort,
    private readonly options: { pollIntervalMs?: number; heartbeatIntervalMs?: number } = {},
  ) {}

  async stream(
    sessionToken: string | undefined,
    rawDeploymentId: string,
    lastEventId: string | undefined,
    connection: LiveOutputConnection,
  ): Promise<void> {
    const { userId } = await this.auth.authenticate(sessionToken);
    const deploymentId = parseUuid(rawDeploymentId);
    let cursor = parseCursor(lastEventId);
    const deployment = await this.dashboard.findDeployment(userId, deploymentId);
    if (deployment === null) throw new NotFoundException();

    // Preflight the cursor and owner-scoped log read before committing SSE headers.
    let initialPage: LiveOutputLogPage | { kind: "missing" };
    try {
      initialPage = await this.logs.readPage(userId, deploymentId, {
        after: cursor,
        limit: LOG_PAGE_SIZE,
      });
    } catch (error) {
      if (error instanceof LogChunkValidationError) {
        throw new BadRequestException("Last-Event-ID is outside the deployment log range");
      }
      throw error;
    }
    if (initialPage.kind === "missing") throw new NotFoundException();

    let closed = false;
    let closeResolve!: () => void;
    const closedSignal = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });
    let heartbeat: NodeJS.Timeout | undefined;
    const removeCloseListener = connection.onClose(() => {
      closed = true;
      closeResolve();
      if (heartbeat) clearInterval(heartbeat);
    });

    try {
      if (closed) return;
      connection.start();
      let lastStatus = JSON.stringify(statusProjection(deployment));
      connection.send(eventFrame("status", statusProjection(deployment)));
      cursor = await emitPage(connection, initialPage, cursor, userId, deploymentId, this.logs);
      if (closed) return;

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          connection.send(": heartbeat\n\n");
        } catch {
          closed = true;
          closeResolve();
        }
      }, this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      while (!closed) {
        await waitForPollOrClose(closedSignal, this.options.pollIntervalMs ?? POLL_INTERVAL_MS);
        if (closed) break;

        const refreshed = await this.dashboard.findDeployment(userId, deploymentId);
        if (refreshed === null) break;
        const nextStatus = JSON.stringify(statusProjection(refreshed));
        if (nextStatus !== lastStatus) {
          connection.send(eventFrame("status", JSON.parse(nextStatus)));
          lastStatus = nextStatus;
        }

        const page = await this.logs.readPage(userId, deploymentId, {
          after: cursor,
          limit: LOG_PAGE_SIZE,
        });
        if (page.kind === "missing") break;
        cursor = await emitPage(connection, page, cursor, userId, deploymentId, this.logs);
      }
    } catch {
      // Do not log database error details; they may include connection data.
      if (!closed) {
        this.logger.error(
          `Live output stream failed for deployment ${deploymentId}; connection closed`,
        );
      }
    } finally {
      closed = true;
      closeResolve();
      if (heartbeat) clearInterval(heartbeat);
      removeCloseListener();
      connection.end();
    }
  }
}

async function emitPage(
  connection: LiveOutputConnection,
  firstPage: LiveOutputLogPage,
  initialCursor: number,
  userId: string,
  deploymentId: string,
  logs: LiveOutputLogPort,
): Promise<number> {
  let cursor = initialCursor;
  let page = firstPage;
  do {
    if (page.gap) {
      connection.send(eventFrame("gap", { resumeSequence: page.gap.resumeSequence }));
      cursor = page.gap.resumeSequence - 1;
    }
    for (const chunk of page.chunks) {
      if (chunk.sequence <= cursor) continue;
      connection.send(
        `id: ${chunk.sequence}\n${eventFrame("log", {
          sequence: chunk.sequence,
          stage: chunk.stage,
          stream: chunk.stream,
          text: chunk.text,
          createdAt: chunk.createdAt.toISOString(),
        })}`,
      );
      cursor = chunk.sequence;
    }
    if (!page.hasMore) break;
    const nextPage = await logs.readPage(userId, deploymentId, {
      after: cursor,
      limit: LOG_PAGE_SIZE,
    });
    if (nextPage.kind === "missing") break;
    page = nextPage;
  } while (page.hasMore);
  return cursor;
}

function eventFrame(event: "status" | "gap" | "log", payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function statusProjection(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid dashboard deployment projection");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "id",
    "attempt",
    "commitSha",
    "status",
    "failureStage",
    "failureCode",
    "failureMessage",
    "failureRetryable",
    "imageDigest",
    "startedAt",
    "finishedAt",
    "createdAt",
    "updatedAt",
  ];
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}

function parseUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new BadRequestException("deploymentId must be a UUID");
  return value;
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new BadRequestException("Last-Event-ID must be a numeric log sequence");
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor > MAX_LOG_SEQUENCE) {
    throw new BadRequestException("Last-Event-ID is outside the supported range");
  }
  return cursor;
}

async function waitForPollOrClose(closedSignal: Promise<void>, intervalMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closedSignal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
