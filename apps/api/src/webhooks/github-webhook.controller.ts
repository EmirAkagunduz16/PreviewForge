import { Controller, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { GithubWebhookService } from "./github-webhook.service.js";
import type { RawWebhookRequest } from "./webhook.types.js";

type RawExpressRequest = Request & RawWebhookRequest;

@Controller("webhooks")
export class GithubWebhookController {
  constructor(private readonly service: GithubWebhookService) {}

  @Post("github")
  receive(@Req() request: RawExpressRequest) {
    return this.service.handle(request, {
      signature: request.headers["x-hub-signature-256"],
      event: request.headers["x-github-event"],
      delivery: request.headers["x-github-delivery"],
    });
  }
}
