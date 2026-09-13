import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { createErrorEnvelope } from "./api-exception.filter.js";

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
});
