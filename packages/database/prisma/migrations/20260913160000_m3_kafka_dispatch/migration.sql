-- M3 Kafka dispatch and worker claims. This migration is additive and keeps
-- PostgreSQL authoritative for relay claims, worker leases, and delivery
-- outcomes. Existing M1/M2 rows remain publishable and claimable.

ALTER TABLE "deployments"
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_owner" TEXT,
  ADD COLUMN "lease_generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_acquired_at" TIMESTAMP(3),
  ADD COLUMN "lease_renewed_at" TIMESTAMP(3),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3);

ALTER TABLE "outbox_events"
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "claim_owner" TEXT,
  ADD COLUMN "claim_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "dead_lettered_at" TIMESTAMP(3),
  ADD COLUMN "dead_letter_reason" TEXT;

CREATE TABLE "kafka_deliveries" (
  "id" UUID NOT NULL,
  "consumer_name" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "partition" INTEGER NOT NULL,
  "offset" BIGINT NOT NULL,
  "event_id" UUID,
  "event_type" TEXT,
  "environment_id" UUID,
  "aggregate_id" UUID,
  "payload_digest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_attempt_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "dead_lettered_at" TIMESTAMP(3),
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "kafka_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployments_environment_id_lease_expires_at_idx"
  ON "deployments"("environment_id", "lease_expires_at");
CREATE INDEX "deployments_status_lease_expires_at_idx"
  ON "deployments"("status", "lease_expires_at");

CREATE INDEX "outbox_events_published_at_available_at_claim_expires_at_idx"
  ON "outbox_events"("published_at", "available_at", "claim_expires_at");
CREATE INDEX "outbox_events_dead_lettered_at_available_at_idx"
  ON "outbox_events"("dead_lettered_at", "available_at");

CREATE UNIQUE INDEX "kafka_deliveries_consumer_name_topic_partition_offset_key"
  ON "kafka_deliveries"("consumer_name", "topic", "partition", "offset");
CREATE INDEX "kafka_deliveries_consumer_name_event_id_idx"
  ON "kafka_deliveries"("consumer_name", "event_id");
CREATE INDEX "kafka_deliveries_status_available_at_idx"
  ON "kafka_deliveries"("status", "available_at");
CREATE INDEX "kafka_deliveries_payload_digest_idx"
  ON "kafka_deliveries"("payload_digest");

ALTER TABLE "deployments"
  ADD CONSTRAINT "deployments_lease_generation_nonnegative_check"
  CHECK ("lease_generation" >= 0),
  ADD CONSTRAINT "deployments_lease_claim_all_or_none_check"
  CHECK (
    ("lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
    OR
    ("lease_token" IS NOT NULL AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "deployments_lease_acquired_requires_claim_check"
  CHECK ("lease_acquired_at" IS NULL OR "lease_token" IS NOT NULL),
  ADD CONSTRAINT "deployments_lease_renewed_requires_claim_check"
  CHECK ("lease_renewed_at" IS NULL OR "lease_token" IS NOT NULL);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempts_nonnegative_check"
  CHECK ("attempts" >= 0),
  ADD CONSTRAINT "outbox_events_claim_all_or_none_check"
  CHECK (
    ("claim_token" IS NULL AND "claim_owner" IS NULL AND "claim_expires_at" IS NULL)
    OR
    ("claim_token" IS NOT NULL AND "claim_owner" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "outbox_events_published_dead_letter_exclusive_check"
  CHECK ("published_at" IS NULL OR "dead_lettered_at" IS NULL);

ALTER TABLE "kafka_deliveries"
  ADD CONSTRAINT "kafka_deliveries_partition_nonnegative_check"
  CHECK ("partition" >= 0),
  ADD CONSTRAINT "kafka_deliveries_offset_nonnegative_check"
  CHECK ("offset" >= 0),
  ADD CONSTRAINT "kafka_deliveries_attempts_positive_check"
  CHECK ("attempts" > 0),
  ADD CONSTRAINT "kafka_deliveries_payload_digest_sha256_check"
  CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "kafka_deliveries_status_check"
  CHECK ("status" IN ('RECEIVED', 'RETRY_SCHEDULED', 'PROCESSED', 'DEAD_LETTER')),
  ADD CONSTRAINT "kafka_deliveries_status_error_consistency_check"
  CHECK (
    (
      "status" = 'RECEIVED'
      AND "processed_at" IS NULL
      AND "dead_lettered_at" IS NULL
      AND "error_code" IS NULL
      AND "error_message" IS NULL
    )
    OR (
      "status" = 'RETRY_SCHEDULED'
      AND "processed_at" IS NULL
      AND "dead_lettered_at" IS NULL
      AND "error_code" IS NOT NULL
      AND "error_message" IS NOT NULL
    )
    OR (
      "status" = 'PROCESSED'
      AND "processed_at" IS NOT NULL
      AND "dead_lettered_at" IS NULL
      AND "error_code" IS NULL
      AND "error_message" IS NULL
    )
    OR (
      "status" = 'DEAD_LETTER'
      AND "processed_at" IS NULL
      AND "dead_lettered_at" IS NOT NULL
      AND "error_code" IS NOT NULL
      AND "error_message" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "kafka_deliveries_safe_identity_fields_check"
  CHECK (length("consumer_name") > 0 AND length("topic") > 0);
