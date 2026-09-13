export class ProjectImportError extends Error {
  override readonly name = "ProjectImportError";

  constructor(
    message: string,
    readonly code:
      | "REPOSITORY_NOT_ACCESSIBLE"
      | "REPOSITORY_IDENTITY_CONFLICT"
      | "DOCKERFILE_NOT_FILE"
      | "DOCKERFILE_NOT_FOUND"
      | "DOCKERFILE_CHECK_FAILED"
      | "DOCKERFILE_PATH_MISMATCH"
      | "INVALID_REPOSITORY_NAME",
  ) {
    super(message);
  }
}
