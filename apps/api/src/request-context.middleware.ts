import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { StructuredLogger } from "./structured-logger.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type RequestWithContext = Request & { requestId: string };

export function requestContextMiddleware(logger: StructuredLogger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = performance.now();
    const incomingRequestId = request.header("x-request-id");
    const requestId =
      incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();

    (request as RequestWithContext).requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      logger.event("info", "http.request.completed", {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        method: request.method,
        path: request.originalUrl,
        requestId,
        statusCode: response.statusCode,
      });
    });

    next();
  };
}
