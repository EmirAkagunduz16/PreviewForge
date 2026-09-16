CREATE TABLE "project_environment_variables" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "encrypted_value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_environment_variables_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_environment_variables_project_id_key_key"
    ON "project_environment_variables"("project_id", "key");
CREATE INDEX "project_environment_variables_project_id_updated_at_idx"
    ON "project_environment_variables"("project_id", "updated_at");
ALTER TABLE "project_environment_variables"
    ADD CONSTRAINT "project_environment_variables_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
