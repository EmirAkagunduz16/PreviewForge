-- Forward-only M2 data hardening. The original M2 migration is already
-- applied in some environments and is intentionally left byte-for-byte
-- unchanged; this migration repairs those environments safely.

-- GitHub installation IDs are also immutable numeric identities and must not
-- be limited to PostgreSQL INTEGER's 32-bit range.
ALTER TABLE "installations"
  ALTER COLUMN "github_installation_id" TYPE BIGINT
  USING "github_installation_id"::BIGINT;

-- Canonical opaque values are lowercase SHA-256 hex digests, never raw
-- browser tokens or ad-hoc prefixed strings.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_hash_sha256_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "oauth_states"
  ADD CONSTRAINT "oauth_states_state_hash_sha256_check"
  CHECK ("state_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "oauth_states_binding_hash_sha256_check"
  CHECK ("binding_hash" ~ '^[0-9a-f]{64}$');

-- Match the strict relative POSIX path and health-path boundary contracts at
-- the persistence boundary as well as at the request boundary.
ALTER TABLE "projects"
  DROP CONSTRAINT "projects_dockerfile_path_safe_check",
  DROP CONSTRAINT "projects_health_path_safe_check";
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_dockerfile_path_safe_check"
  CHECK (
    length("dockerfile_path") BETWEEN 1 AND 512
    AND left("dockerfile_path", 1) <> '/'
    AND position(chr(92) in "dockerfile_path") = 0
    AND "dockerfile_path" !~ '[[:cntrl:]]'
    AND "dockerfile_path" !~ '(^|/)(\.{1,2})(/|$)'
    AND "dockerfile_path" !~ '//'
  ),
  ADD CONSTRAINT "projects_health_path_safe_check"
  CHECK (
    length("health_path") BETWEEN 1 AND 2048
    AND left("health_path", 1) = '/'
    AND position('?' in "health_path") = 0
    AND position('#' in "health_path") = 0
    AND position('://' in "health_path") = 0
    AND position(chr(92) in "health_path") = 0
    AND "health_path" !~ '[[:cntrl:]]'
    AND (
      "health_path" = '/'
      OR (
        "health_path" !~ '//'
        AND right("health_path", 1) <> '/'
        AND "health_path" !~ '(^|/)(\.{1,2})(/|$)'
      )
    )
  );

-- Installation IDs are assigned by GitHub and remain stable for the life of
-- the installation record. This complements the existing account/owner
-- immutability triggers from the first M2 migration.
CREATE OR REPLACE FUNCTION "previewforge_prevent_installation_identity_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."github_installation_id" IS DISTINCT FROM NEW."github_installation_id" THEN
    RAISE EXCEPTION 'github installation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "installations_github_installation_immutable_trigger"
BEFORE UPDATE OF "github_installation_id" ON "installations"
FOR EACH ROW EXECUTE FUNCTION "previewforge_prevent_installation_identity_change"();
