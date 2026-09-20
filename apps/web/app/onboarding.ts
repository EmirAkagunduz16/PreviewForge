export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const AUTH_REQUIRED_MESSAGE = "Sign in to view your previews.";

export function userFacingApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return AUTH_REQUIRED_MESSAGE;
    if (error.status >= 500) return "PreviewForge API is unavailable. Check the local runtime.";
    return error.message || fallback;
  }
  return "PreviewForge API is unavailable. Check the local runtime.";
}

export function importErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) {
    return "Import could not be completed. Check the local API and try again.";
  }
  switch (error.code) {
    case "REPOSITORY_NOT_ACCESSIBLE":
      return "GitHub App read access is required for this repository.";
    case "REPOSITORY_IDENTITY_CONFLICT":
      return "The repository identity changed. Reload the repository list and try again.";
    case "DOCKERFILE_NOT_FOUND":
    case "DOCKERFILE_NOT_FILE":
    case "DOCKERFILE_PATH_MISMATCH":
      return "The Dockerfile path does not point to a file in this repository.";
    case "DOCKERFILE_CHECK_FAILED":
      return "The Dockerfile could not be verified. Check GitHub access and try again.";
    case "INVALID_PROJECT_IMPORT":
      return "Check the Dockerfile path, container port, and health path.";
    default:
      return error.status >= 500
        ? "PreviewForge API is unavailable. Check the local runtime."
        : error.message || "Import could not be completed.";
  }
}
