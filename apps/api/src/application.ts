import { NestFactory } from "@nestjs/core";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { AppModule } from "./app.module.js";
import type { ApiConfig } from "./config.js";
import { requestContextMiddleware } from "./request-context.middleware.js";
import { StructuredLogger } from "./structured-logger.js";

export async function createApplication(config: ApiConfig) {
  const logger = new StructuredLogger(config.logLevel);
  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger });

  app.use(requestContextMiddleware(logger));
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();
  app.setGlobalPrefix("api", { exclude: ["health"] });

  return app;
}
