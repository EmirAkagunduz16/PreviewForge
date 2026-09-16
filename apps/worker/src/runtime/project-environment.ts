import type { ProjectEnvironmentRepository } from "@previewforge/database";
import { type CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";

export class EnvironmentDecryptionError extends Error {
  readonly code = "ENVIRONMENT_VARIABLE_DECRYPTION_FAILED";
  constructor() {
    super("Project environment configuration could not be authenticated");
  }
}

export async function loadProjectEnvironment(
  repository: Pick<ProjectEnvironmentRepository, "listEncryptedByProjectId">,
  cipher: CredentialCipher,
  projectId: string,
): Promise<Record<string, string>> {
  const rows = await repository.listEncryptedByProjectId(projectId);
  const values: Record<string, string> = {};
  try {
    for (const row of rows) {
      Object.defineProperty(values, row.key, {
        value: cipher.decrypt(
          row.encryptedValue,
          projectEnvironmentAssociatedData(projectId, row.key),
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    throw new EnvironmentDecryptionError();
  }
  return values;
}
