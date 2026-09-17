import { PreviewForgeTelemetry } from "@previewforge/observability";

export const DEFAULT_WORKER_OBSERVABILITY_PORT = 9465;

export function createWorkerTelemetry(): PreviewForgeTelemetry {
  return new PreviewForgeTelemetry("previewforge-worker", {
    ...(process.env.PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: process.env.PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT }),
  });
}
