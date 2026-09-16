ALTER TABLE "deployments"
ADD COLUMN "log_sequence_high_watermark" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "log_chunks"
ADD COLUMN "created_at" TIMESTAMPTZ(3);

UPDATE "log_chunks"
SET "created_at" = "emitted_at";

ALTER TABLE "log_chunks"
ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "created_at" SET NOT NULL;

UPDATE "deployments" AS deployment
SET "log_sequence_high_watermark" = COALESCE(
  (SELECT MAX(chunk."sequence") FROM "log_chunks" AS chunk WHERE chunk."deployment_id" = deployment."id"),
  0
);

CREATE INDEX "log_chunks_deployment_created_at_idx"
ON "log_chunks"("deployment_id", "created_at");
