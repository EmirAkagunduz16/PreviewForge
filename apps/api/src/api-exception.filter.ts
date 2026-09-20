import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import type { RequestWithContext } from "./request-context.middleware.js";
import type { StructuredLogger } from "./structured-logger.js";

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
    statusCode: number;
  };
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const envelope = createErrorEnvelope(exception, statusCode, request.requestId);

    if (statusCode >= 500) {
      this.logger.event("error", "http.request.failed", {
        requestId: request.requestId,
        statusCode,
        exceptionType: exception instanceof Error ? exception.name : typeof exception,
      });
    }

    // Streaming responses (notably SSE) may fail after their headers have
    // already been flushed or after the client has disconnected. Do not try
    // to replace a committed/destroyed response with a JSON error envelope.
    if (response.headersSent || response.destroyed || response.writableEnded) return;

    response.status(statusCode).json(envelope);
  }
}

export function createErrorEnvelope(
  exception: unknown,
  statusCode: number,
  requestId: string,
): ErrorEnvelope {
  const isServerError = statusCode >= 500;
  const message = isServerError ? "Internal server error" : getPublicMessage(exception);

  return {
    error: {
      code: isServerError ? getErrorCode(statusCode) : getPublicErrorCode(exception, statusCode),
      message,
      requestId,
      statusCode,
    },
  };
}

function getPublicErrorCode(exception: unknown, statusCode: number): string {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (
      isRecord(body) &&
      typeof body.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(body.code)
    ) {
      return body.code;
    }
  }
  return getErrorCode(statusCode);
}

function getPublicMessage(exception: unknown): string {
  if (!(exception instanceof HttpException)) {
    return "Request failed";
  }

  const body = exception.getResponse();
  if (typeof body === "string") {
    return body;
  }

  if (!isRecord(body)) {
    return exception.message;
  }

  if (!("message" in body)) {
    return exception.message;
  }

  const message = body.message;
  if (Array.isArray(message)) {
    return message.filter((item): item is string => typeof item === "string").join("; ");
  }

  return typeof message === "string" ? message : exception.message;
}

function getErrorCode(statusCode: number): string {
  return HttpStatus[statusCode]?.toString() ?? "HTTP_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
