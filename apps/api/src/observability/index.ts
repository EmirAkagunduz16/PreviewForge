import { PreviewForgeTelemetry } from "@previewforge/observability";
import type { Request, Response } from "express";

export function createApiTelemetry(): PreviewForgeTelemetry {
  return new PreviewForgeTelemetry("previewforge-api", {
    ...(process.env.PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: process.env.PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT }),
  });
}

export function registerObservabilityRoutes(
  app: { get(path: string, handler: (request: Request, response: Response) => void): void },
  telemetry: PreviewForgeTelemetry,
): void {
  app.get("/metrics", (_request, response) => {
    response.type("text/plain; version=0.0.4").send(telemetry.metrics.renderPrometheus());
  });
  app.get("/traces", (_request, response) => {
    response.type("application/json").send(telemetry.renderTraces());
  });
}

export function stableRouteFamily(request: Request): string {
  const route = request.route?.path;
  if (typeof route === "string" && route.length > 0) {
    return normalizeRoute(route);
  }
  const pathname = request.path || request.originalUrl.split("?", 1)[0] || "/";
  return normalizeRoute(pathname);
}

function normalizeRoute(value: string): string {
  return (
    value
      .split("/")
      .map((segment) => {
        if (segment === "") return "";
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            segment,
          )
        ) {
          return ":id";
        }
        if (/^[0-9a-f]{40}$/iu.test(segment)) return ":sha";
        if (/^\d+$/u.test(segment)) return ":number";
        return segment.length <= 64 && /^[A-Za-z0-9._:-]+$/u.test(segment) ? segment : ":param";
      })
      .join("/") || "/"
  );
}
