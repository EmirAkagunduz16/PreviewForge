-- M2 GitHub App data. This migration is additive so it can be applied to
-- populated M1 databases without rewriting or deleting existing rows.

ALTER TABLE "users"
  ADD COLUMN "github_numeric_id" BIGINT;

ALTER TABLE "installations"
  ADD COLUMN "github_account_id" BIGINT;

ALTER TABLE "projects"
  ADD COLUMN "github_repository_id" BIGINT,
  ADD COLUMN "dockerfile_path" TEXT NOT NULL DEFAULT 'Dockerfile',
  ADD COLUMN "container_port" INTEGER NOT NULL DEFAULT 3000,
  ADD COLUMN "health_path" TEXT NOT NULL DEFAULT '/';

ALTER TABLE "pull_requests"
  ADD COLUMN "source_updated_at" TIMESTAMP(3),
  ADD COLUMN "last_webhook_delivery_id" TEXT,
  ADD COLUMN "last_webhook_event" TEXT,
  ADD COLUMN "last_webhook_at" TIMESTAMP(3),
  ADD COLUMN "closed_at" TIMESTAMP(3);

ALTER TABLE "webhook_deliveries"
  ADD COLUMN "source_updated_at" TIMESTAMP(3),
  ADD COLUMN "source_sequence" BIGINT,
  ADD COLUMN "duplicate_of_delivery_id" TEXT;

CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oauth_states" (
  "id" UUID NOT NULL,
  "state_hash" TEXT NOT NULL,
  "binding_hash" TEXT NOT NULL,
  "encrypted_pkce_verifier" TEXT NOT NULL,
  "flow" TEXT NOT NULL,
  "user_id" UUID,
  "installation_id" UUID,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_credentials" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "encrypted_access_token" TEXT NOT NULL,
  "encrypted_refresh_token" TEXT,
  "access_token_expires_at" TIMESTAMP(3),
  "refresh_token_expires_at" TIMESTAMP(3),
  "token_type" TEXT,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ciphertext_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "github_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "environment_deletion_requests" (
  "id" UUID NOT NULL,
  "environment_id" UUID NOT NULL,
  "request_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "source_updated_at" TIMESTAMP(3),
  "source_delivery_id" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "environment_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_github_numeric_id_key"
  ON "users"("github_numeric_id");
CREATE UNIQUE INDEX "installations_github_account_id_key"
  ON "installations"("github_account_id");
CREATE UNIQUE INDEX "projects_github_repository_id_key"
  ON "projects"("github_repository_id");
CREATE UNIQUE INDEX "sessions_token_hash_key"
  ON "sessions"("token_hash");
CREATE UNIQUE INDEX "oauth_states_state_hash_key"
  ON "oauth_states"("state_hash");
CREATE UNIQUE INDEX "github_credentials_user_id_key"
  ON "github_credentials"("user_id");
CREATE UNIQUE INDEX "environment_deletion_requests_environment_id_key"
  ON "environment_deletion_requests"("environment_id");
CREATE UNIQUE INDEX "environment_deletion_requests_request_key_key"
  ON "environment_deletion_requests"("request_key");

CREATE INDEX "sessions_user_id_expires_at_idx"
  ON "sessions"("user_id", "expires_at");
CREATE INDEX "sessions_expires_at_idx"
  ON "sessions"("expires_at");
CREATE INDEX "oauth_states_expires_at_consumed_at_idx"
  ON "oauth_states"("expires_at", "consumed_at");
CREATE INDEX "oauth_states_user_id_flow_idx"
  ON "oauth_states"("user_id", "flow");
CREATE INDEX "github_credentials_access_token_expires_at_idx"
  ON "github_credentials"("access_token_expires_at");
CREATE INDEX "github_credentials_refresh_token_expires_at_idx"
  ON "github_credentials"("refresh_token_expires_at");
CREATE INDEX "environment_deletion_requests_status_requested_at_idx"
  ON "environment_deletion_requests"("status", "requested_at");
CREATE INDEX "environment_deletion_requests_source_delivery_id_idx"
  ON "environment_deletion_requests"("source_delivery_id");
CREATE INDEX "pull_requests_source_updated_at_idx"
  ON "pull_requests"("source_updated_at");
CREATE INDEX "webhook_deliveries_source_updated_at_idx"
  ON "webhook_deliveries"("source_updated_at");

ALTER TABLE "users"
  ADD CONSTRAINT "users_github_numeric_id_positive_check"
  CHECK ("github_numeric_id" IS NULL OR "github_numeric_id" > 0);
ALTER TABLE "installations"
  ADD CONSTRAINT "installations_github_account_id_positive_check"
  CHECK ("github_account_id" IS NULL OR "github_account_id" > 0);
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_github_repository_id_positive_check"
  CHECK ("github_repository_id" IS NULL OR "github_repository_id" > 0),
  ADD CONSTRAINT "projects_container_port_range_check"
  CHECK ("container_port" BETWEEN 1 AND 65535),
  ADD CONSTRAINT "projects_dockerfile_path_safe_check"
  CHECK (
    length("dockerfile_path") > 0
    AND left("dockerfile_path", 1) <> '/'
    AND position('..' in "dockerfile_path") = 0
  ),
  ADD CONSTRAINT "projects_health_path_safe_check"
  CHECK (
    left("health_path", 1) = '/'
    AND position('://' in "health_path") = 0
    AND position(E'\n' in "health_path") = 0
  );
ALTER TABLE "oauth_states"
  ADD CONSTRAINT "oauth_states_flow_check"
  CHECK ("flow" IN ('SIGN_IN', 'INSTALL')),
  ADD CONSTRAINT "oauth_states_expiry_check"
  CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "oauth_states_consumed_after_created_check"
  CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at");
ALTER TABLE "github_credentials"
  ADD CONSTRAINT "github_credentials_ciphertext_version_check"
  CHECK ("ciphertext_version" > 0),
  ADD CONSTRAINT "github_credentials_refresh_expiry_check"
  CHECK ("encrypted_refresh_token" IS NOT NULL OR "refresh_token_expires_at" IS NULL);
ALTER TABLE "environment_deletion_requests"
  ADD CONSTRAINT "environment_deletion_requests_status_check"
  CHECK ("status" IN ('REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  ADD CONSTRAINT "environment_deletion_requests_completed_at_check"
  CHECK ("status" NOT IN ('COMPLETED', 'CANCELLED') OR "completed_at" IS NOT NULL);

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oauth_states"
  ADD CONSTRAINT "oauth_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "oauth_states_installation_id_fkey"
  FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "github_credentials"
  ADD CONSTRAINT "github_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "environment_deletion_requests"
  ADD CONSTRAINT "environment_deletion_requests_environment_id_fkey"
  FOREIGN KEY ("environment_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Installation ownership is assigned once by the verified setup callback and
-- must not be transferred by a later callback or retry.
CREATE OR REPLACE FUNCTION "previewforge_prevent_installation_owner_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."owner_id" IS DISTINCT FROM NEW."owner_id" THEN
    RAISE EXCEPTION 'installation owner is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "installations_owner_immutable_trigger"
BEFORE UPDATE OF "owner_id" ON "installations"
FOR EACH ROW EXECUTE FUNCTION "previewforge_prevent_installation_owner_change"();

-- Numeric GitHub identities are canonical and never change after import.
CREATE OR REPLACE FUNCTION "previewforge_prevent_github_identity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'users'
     AND (to_jsonb(OLD)->'github_numeric_id') IS DISTINCT FROM (to_jsonb(NEW)->'github_numeric_id')
     AND (to_jsonb(OLD)->'github_numeric_id') IS NOT NULL THEN
    RAISE EXCEPTION 'github user identity is immutable';
  ELSIF TG_TABLE_NAME = 'installations'
     AND (to_jsonb(OLD)->'github_account_id') IS DISTINCT FROM (to_jsonb(NEW)->'github_account_id')
     AND (to_jsonb(OLD)->'github_account_id') IS NOT NULL THEN
    RAISE EXCEPTION 'github account identity is immutable';
  ELSIF TG_TABLE_NAME = 'projects'
     AND (to_jsonb(OLD)->'github_repository_id') IS DISTINCT FROM (to_jsonb(NEW)->'github_repository_id')
     AND (to_jsonb(OLD)->'github_repository_id') IS NOT NULL THEN
    RAISE EXCEPTION 'github repository identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "users_github_identity_immutable_trigger"
BEFORE UPDATE OF "github_numeric_id" ON "users"
FOR EACH ROW EXECUTE FUNCTION "previewforge_prevent_github_identity_change"();
CREATE TRIGGER "installations_github_identity_immutable_trigger"
BEFORE UPDATE OF "github_account_id" ON "installations"
FOR EACH ROW EXECUTE FUNCTION "previewforge_prevent_github_identity_change"();
CREATE TRIGGER "projects_github_identity_immutable_trigger"
BEFORE UPDATE OF "github_repository_id" ON "projects"
FOR EACH ROW EXECUTE FUNCTION "previewforge_prevent_github_identity_change"();

-- A consumed OAuth state is a one-time capability. It may not be replayed or
-- reset to an unconsumed state by an update.
CREATE OR REPLACE FUNCTION "previewforge_prevent_oauth_state_reuse"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at" THEN
    RAISE EXCEPTION 'oauth state has already been consumed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "oauth_states_one_time_trigger"
BEFORE UPDATE OF "consumed_at" ON "oauth_states"
FOR EACH ROW EXECUTE FUNCTION "previewforge_prevent_oauth_state_reuse"();
