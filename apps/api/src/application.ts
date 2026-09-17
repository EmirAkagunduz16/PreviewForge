import type { IncomingMessage } from "node:http";
import { NestFactory } from "@nestjs/core";
import express from "express";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { AppModule } from "./app.module.js";
import type { ApiConfig } from "./config.js";
import { createApiTelemetry, registerObservabilityRoutes } from "./observability/index.js";
import { requestContextMiddleware } from "./request-context.middleware.js";
import { StructuredLogger } from "./structured-logger.js";

export async function createApplication(config: ApiConfig) {
  const logger = new StructuredLogger(config.logLevel);
  const telemetry = createApiTelemetry();
  // Nest's default parser consumes the stream before webhook handlers can
  // authenticate it. Install the parser ourselves and retain the exact bytes
  // received on the wire for HMAC verification.
  const app = await NestFactory.create(AppModule.register(config), {
    bufferLogs: true,
    bodyParser: false,
    logger,
  });

  app.use(
    express.json({
      verify: captureRawBody,
      limit: "1mb",
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: "64kb" }));

  registerObservabilityRoutes(app.getHttpAdapter().getInstance(), telemetry);
  app.use(requestContextMiddleware(logger, telemetry));
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();
  app.setGlobalPrefix("api", { exclude: ["health"] });

  return app;
}

export type RawBodyRequest = IncomingMessage & { rawBody?: Buffer };

function captureRawBody(request: IncomingMessage, _response: unknown, body: Buffer): void {
  (request as RawBodyRequest).rawBody = Buffer.from(body);
}
