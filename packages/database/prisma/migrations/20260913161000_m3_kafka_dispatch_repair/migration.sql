-- M3 data hardening. The initial M3 migration is already deployed in some
-- environments, so these constraints are additive and leave its SQL intact.

ALTER TABLE "deployments"
  ADD CONSTRAINT "deployments_active_lease_status_check"
  CHECK (
    "lease_token" IS NULL
    OR "status" IN ('CLONING', 'BUILDING', 'PUSHING', 'DEPLOYING', 'WAITING_FOR_HEALTHCHECK')
  ),
  ADD CONSTRAINT "deployments_active_lease_generation_check"
  CHECK ("lease_token" IS NULL OR "lease_generation" > 0),
  ADD CONSTRAINT "deployments_active_lease_owner_nonempty_check"
  CHECK (
    "lease_token" IS NULL
    OR length(btrim("lease_owner")) BETWEEN 1 AND 255
  ),
  ADD CONSTRAINT "deployments_active_lease_timestamps_coherent_check"
  CHECK (
    "lease_token" IS NULL
    OR (
      "lease_acquired_at" IS NOT NULL
      AND "lease_expires_at" > "lease_acquired_at"
      AND (
        "lease_renewed_at" IS NULL
        OR (
          "lease_renewed_at" >= "lease_acquired_at"
          AND "lease_expires_at" > "lease_renewed_at"
        )
      )
    )
  );

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_claim_owner_nonempty_check"
  CHECK (
    "claim_token" IS NULL
    OR length(btrim("claim_owner")) BETWEEN 1 AND 255
  ),
  ADD CONSTRAINT "outbox_claim_only_pending_check"
  CHECK (
    "claim_token" IS NULL
    OR ("published_at" IS NULL AND "dead_lettered_at" IS NULL)
  ),
  ADD CONSTRAINT "outbox_attempt_metadata_coherent_check"
  CHECK (
    ("attempts" = 0 AND "last_attempt_at" IS NULL)
    OR ("attempts" > 0 AND "last_attempt_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "outbox_last_error_safe_length_check"
  CHECK (
    "last_error" IS NULL
    OR (
      "attempts" > 0
      AND length("last_error") BETWEEN 1 AND 2000
      AND "last_error" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "outbox_dead_letter_metadata_coherent_check"
  CHECK (
    ("dead_lettered_at" IS NULL AND "dead_letter_reason" IS NULL)
    OR (
      "dead_lettered_at" IS NOT NULL
      AND length("dead_letter_reason") BETWEEN 1 AND 2000
      AND btrim("dead_letter_reason") <> ''
      AND "dead_letter_reason" !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE "kafka_deliveries"
  ADD CONSTRAINT "kafka_deliveries_safe_metadata_length_check"
  CHECK (
    length("consumer_name") BETWEEN 1 AND 128
    AND "consumer_name" !~ '[[:cntrl:]]'
    AND length("topic") BETWEEN 1 AND 249
    AND "topic" !~ '[[:cntrl:]]'
    AND ("event_type" IS NULL OR (length("event_type") BETWEEN 1 AND 128 AND "event_type" !~ '[[:cntrl:]]'))
    AND ("error_message" IS NULL OR (length("error_message") BETWEEN 1 AND 2000 AND "error_message" !~ '[[:cntrl:]]'))
  ),
  ADD CONSTRAINT "kafka_deliveries_attempt_metadata_coherent_check"
  CHECK ("attempts" = 1 OR "last_attempt_at" IS NOT NULL),
  ADD CONSTRAINT "kafka_deliveries_error_code_format_check"
  CHECK (
    "error_code" IS NULL
    OR "error_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'
  );
