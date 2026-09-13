import type { PullRequestEvent } from "@previewforge/contracts";
import type { WebhookProcessResult, WebhookRepositoryInput } from "./webhook.types.internal.js";

export type { PullRequestEvent } from "@previewforge/contracts";

export type { WebhookProcessResult, WebhookRepositoryInput } from "./webhook.types.internal.js";

export interface WebhookRepositoryPort {
  process(input: WebhookRepositoryInput): Promise<WebhookProcessResult>;
}

export type RawWebhookRequest = {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
};

export type WebhookHeaders = {
  signature: string | string[] | undefined;
  event: string | string[] | undefined;
  delivery: string | string[] | undefined;
};

export type NormalizedWebhookInput = WebhookRepositoryInput & {
  event: PullRequestEvent;
};
