import type { PullRequestEvent } from "@previewforge/contracts";

export type WebhookRepositoryInput = {
  deliveryId: string;
  eventName: "pull_request";
  payloadSha256: string;
  event: PullRequestEvent;
  receivedAt?: Date;
};

export type WebhookProcessResult = {
  deliveryId: string;
  duplicate: boolean;
  stale: boolean;
  action: PullRequestEvent["action"];
  deploymentId?: string;
  deletionRequestId?: string;
};
