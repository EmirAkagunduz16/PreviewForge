import { Controller, Inject, Post, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
// Nest uses the runtime constructor token to resolve this controller service.
// biome-ignore lint/style/useImportType: Nest constructor metadata requires the runtime class.
import { GithubWebhookService } from "./github-webhook.service.js";
import type { RawWebhookRequest, WebhookHeaders } from "./webhook.types.js";

type RawExpressRequest = Request & RawWebhookRequest;

@Controller({ path: "webhooks", scope: Scope.REQUEST })
export class GithubWebhookController {
  @Inject(REQUEST)
  private readonly request!: RawExpressRequest;

  constructor(private readonly service: GithubWebhookService) {}

  @Post("github")
  receive() {
    const headers: WebhookHeaders = {
      signature: this.request.headers["x-hub-signature-256"],
      event: this.request.headers["x-github-event"],
      delivery: this.request.headers["x-github-delivery"],
    };
    return this.service.handle(this.request, headers);
  }
}
