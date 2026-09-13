import { createHmac } from "node:crypto";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { GithubWebhookService } from "./github-webhook.service.js";
import type { RawWebhookRequest, WebhookRepositoryPort } from "./webhook.types.js";

const secret = "webhook-test-secret";

describe("GithubWebhookService", () => {
  it("verifies the exact raw bytes before handing a normalized event to persistence", async () => {
    const repository: WebhookRepositoryPort = {
      process: vi.fn(async (input) => ({
        deliveryId: input.deliveryId,
        duplicate: false,
        stale: false,
        action: input.event.action,
      })),
    };
    const service = new GithubWebhookService(repository, secret);
    const body = Buffer.from(JSON.stringify(payload()), "utf8");

    const result = await service.handle(request(body), headers(body));

    expect(result).toMatchObject({ deliveryId: "delivery-1", action: "opened" });
    expect(repository.process).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-1",
        eventName: "pull_request",
        event: expect.objectContaining({
          installationId: "123456789012345",
          repositoryId: "987654321098765",
          commitSha: "a".repeat(40),
        }),
      }),
    );
  });

  it("rejects semantically equal JSON with an old signature", async () => {
    const repository: WebhookRepositoryPort = { process: vi.fn() };
    const service = new GithubWebhookService(repository, secret);
    const compact = Buffer.from(JSON.stringify(payload()), "utf8");
    const pretty = Buffer.from(JSON.stringify(payload(), null, 2), "utf8");

    await expect(service.handle(request(pretty), headers(compact))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.process).not.toHaveBeenCalled();
  });

  it("fails closed when the parser did not retain raw bytes", async () => {
    const repository: WebhookRepositoryPort = { process: vi.fn() };
    const service = new GithubWebhookService(repository, secret);

    await expect(
      service.handle(
        { headers: {} },
        { signature: "sha256=" + "0".repeat(64), event: "pull_request", delivery: "delivery-1" },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repository.process).not.toHaveBeenCalled();
  });

  it("rejects unsupported actions and unsafe delivery headers", async () => {
    const repository: WebhookRepositoryPort = { process: vi.fn() };
    const service = new GithubWebhookService(repository, secret);
    const body = Buffer.from(JSON.stringify({ ...payload(), action: "labeled" }), "utf8");

    await expect(service.handle(request(body), headers(body))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.process).not.toHaveBeenCalled();
  });
});

function request(rawBody: Buffer): RawWebhookRequest {
  return { rawBody, headers: {} };
}

function headers(body: Buffer) {
  return {
    signature: createHmac("sha256", secret).update(body).digest("hex").replace(/^/, "sha256="),
    event: "pull_request",
    delivery: "delivery-1",
  } as const;
}

function payload() {
  return {
    action: "opened",
    number: 7,
    installation: { id: 123456789012345 },
    repository: { id: 987654321098765, full_name: "octo/example" },
    pull_request: {
      id: 7654321,
      number: 7,
      head: { sha: "a".repeat(40) },
      updated_at: "2026-09-13T10:00:00.000Z",
    },
  };
}
