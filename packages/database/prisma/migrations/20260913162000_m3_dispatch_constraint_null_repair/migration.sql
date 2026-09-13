-- Close the nullable CHECK expression left by the first M3 hardening pass.
-- This remains additive so already-applied M3 migrations stay immutable.

ALTER TABLE "outbox_events"
  DROP CONSTRAINT "outbox_dead_letter_metadata_coherent_check";

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_dead_letter_metadata_coherent_check"
  CHECK (
    ("dead_lettered_at" IS NULL AND "dead_letter_reason" IS NULL)
    OR (
      "dead_lettered_at" IS NOT NULL
      AND "dead_letter_reason" IS NOT NULL
      AND length("dead_letter_reason") BETWEEN 1 AND 2000
      AND btrim("dead_letter_reason") <> ''
      AND "dead_letter_reason" !~ '[[:cntrl:]]'
    )
  );
