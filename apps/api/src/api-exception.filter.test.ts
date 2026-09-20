import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter, createErrorEnvelope } from "./api-exception.filter.js";
import type { StructuredLogger } from "./structured-logger.js";

describe("createErrorEnvelope", () => {
  it("returns a stable public envelope for client errors", () => {
    expect(createErrorEnvelope(new BadRequestException("invalid input"), 400, "req-1")).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "invalid input",
        requestId: "req-1",
        statusCode: 400,
      },
    });
  });

  it("does not expose internal errors", () => {
    expect(createErrorEnvelope(new Error("database password leaked"), 500, "req-2")).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId: "req-2",
        statusCode: 500,
      },
    });
  });

  it("preserves an explicitly safe domain error code", () => {
    expect(
      createErrorEnvelope(
        new BadRequestException({
          code: "DOCKERFILE_NOT_FOUND",
          message: "Dockerfile was not found",
        }),
        400,
        "req-3",
      ),
    ).toEqual({
      error: {
        code: "DOCKERFILE_NOT_FOUND",
        message: "Dockerfile was not found",
        requestId: "req-3",
        statusCode: 400,
      },
    });
  });
});

describe("ApiExceptionFilter", () => {
  it("does not write a second envelope after a streaming response is committed", () => {
    const response = {
      headersSent: true,
      destroyed: false,
      writableEnded: false,
      status: vi.fn(),
      json: vi.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: "req-stream" }),
        getResponse: () => response,
      }),
    };
    const logger = { event: vi.fn() };

    new ApiExceptionFilter(logger as unknown as StructuredLogger).catch(
      new Error("stream closed"),
      host as never,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });
});
