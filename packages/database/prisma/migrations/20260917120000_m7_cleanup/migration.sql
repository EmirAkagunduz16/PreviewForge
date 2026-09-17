-- M7 cleanup reasons distinguish pull-request close intents from TTL expiry
-- while keeping the existing one-request-per-environment identity.
ALTER TABLE "environment_deletion_requests"
  ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'pull_request_closed';

ALTER TABLE "environment_deletion_requests"
  ADD CONSTRAINT "environment_deletion_requests_reason_check"
  CHECK ("reason" IN ('pull_request_closed', 'ttl_expired'));
