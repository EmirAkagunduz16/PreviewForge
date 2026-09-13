import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { normalizePullRequestWebhookPayload } from "@previewforge/contracts";
import { verifyGitHubSignature } from "../security/github-signature.js";
import { GITHUB_WEBHOOK_REPOSITORY, GITHUB_WEBHOOK_SECRET } from "./webhook.tokens.js";
import type {
  RawWebhookRequest,
  WebhookHeaders,
  WebhookProcessResult,
  WebhookRepositoryPort,
} from "./webhook.types.js";

const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/i;

@Injectable()
export class GithubWebhookService {
  constructor(
    @Inject(GITHUB_WEBHOOK_REPOSITORY)
    private readonly repository: WebhookRepositoryPort,
    @Inject(GITHUB_WEBHOOK_SECRET) private readonly secret: string,
  ) {}

  async handle(
    request: RawWebhookRequest,
    headers: WebhookHeaders,
  ): Promise<WebhookProcessResult> {
    const rawBody = request.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      throw new UnauthorizedException("raw webhook body is required");
    }

    const signature = oneHeader(headers.signature);
    if (!signature || !SIGNATURE_PATTERN.test(signature)) {
      throw new UnauthorizedException("invalid webhook signature");
    }
    if (!verifyGitHubSignature(rawBody, signature, this.secret)) {
      throw new UnauthorizedException("invalid webhook signature");
    }

    const eventName = oneHeader(headers.event);
    const deliveryId = oneHeader(headers.delivery);
    if (eventName !== "pull_request" || !deliveryId || !DELIVERY_PATTERN.test(deliveryId)) {
      throw new BadRequestException("invalid webhook headers");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      throw new BadRequestException("invalid webhook JSON");
    }
    let event: ReturnType<typeof normalizePullRequestWebhookPayload>;
    try {
      event = normalizePullRequestWebhookPayload(parsed);
    } catch {
      throw new BadRequestException("invalid pull_request payload");
    }

    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    try {
      return await this.repository.process({
        deliveryId,
        eventName,
        payloadSha256,
        event,
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "WEBHOOK_DELIVERY_CONFLICT") {
        throw new BadRequestException("conflicting webhook delivery");
      }
      if (code === "WEBHOOK_PROJECT_NOT_FOUND") {
        throw new BadRequestException("webhook repository is not imported");
      }
      if (code === "WEBHOOK_REPOSITORY_IDENTITY_CONFLICT") {
        throw new BadRequestException("webhook repository identity conflicts with an import");
      }
      throw error;
    }
  }
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
