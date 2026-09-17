import { randomUUID } from "node:crypto";
import type { PreviewForgeTelemetry } from "@previewforge/observability";
import type { NextFunction, Request, Response } from "express";
import { stableRouteFamily } from "./observability/index.js";
import type { StructuredLogger } from "./structured-logger.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type RequestWithContext = Request & { requestId: string };

export function requestContextMiddleware(
  logger: StructuredLogger,
  telemetry: PreviewForgeTelemetry,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = performance.now();
    const span = telemetry.startSpan("http.server", undefined, {
      "http.method": request.method,
    });
    const incomingRequestId = request.header("x-request-id");
    const requestId =
      incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();

    (request as RequestWithContext).requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-trace-id", span.context.traceId);
    response.once("finish", () => {
      const route = stableRouteFamily(request);
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const statusCode = response.statusCode;
      span.setAttribute("http.route", route);
      span.setAttribute("http.status_code", statusCode);
      span.end(statusCode >= 500 ? "error" : "ok");
      telemetry.metrics.increment("previewforge_http_requests_total", {
        method: request.method,
        route,
        status_code: statusCode,
      });
      telemetry.metrics.observe("previewforge_http_request_duration_ms", durationMs, {
        method: request.method,
        route,
        status_code: statusCode,
      });
      if (statusCode >= 400) {
        telemetry.metrics.increment("previewforge_api_errors_total", {
          route,
          status_code: statusCode,
          error_code: statusCode >= 500 ? "HTTP_SERVER_ERROR" : "HTTP_CLIENT_ERROR",
        });
      }
      logger.event("info", "http.request.completed", {
        durationMs,
        method: request.method,
        path: route,
        requestId,
        statusCode,
      });
    });

    telemetry.runWithContext(span.context, next);
  };
}
