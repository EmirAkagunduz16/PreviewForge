import { Controller, Get, Inject, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { SESSION_COOKIE } from "../auth/auth.service.js";
import { parseCookie } from "../security/cookies.js";
import { LiveOutputService } from "./live-output.service.js";

@Controller({ path: "deployments", scope: Scope.REQUEST })
export class LiveOutputController {
  @Inject(REQUEST)
  private readonly request!: Request;

  @Inject(LiveOutputService)
  private readonly liveOutput!: LiveOutputService;

  @Get(":deploymentId/events")
  events(): Promise<void> {
    const response = this.request.res;
    if (!response) throw new Error("Express response is unavailable");
    const connection: SseConnection = {
      start: () => {
        response.status(200);
        response.set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
      },
      send: (frame) => {
        if (!response.destroyed && !response.writableEnded) response.write(frame);
      },
      onClose: (callback) => {
        if (response.destroyed) {
          callback();
          return () => undefined;
        }
        response.on("close", callback);
        return () => response.off("close", callback);
      },
      end: () => {
        if (!response.destroyed && !response.writableEnded) response.end();
      },
    };
    return this.liveOutput.stream(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      pathParameter(this.request.params.deploymentId),
      headerValue(this.request.headers["last-event-id"]),
      connection,
    );
  }
}

type SseConnection = {
  start(): void;
  send(frame: string): void;
  onClose(callback: () => void): () => void;
  end(): void;
};

function pathParameter(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return value === undefined ? undefined : typeof value === "string" ? value : "";
}
