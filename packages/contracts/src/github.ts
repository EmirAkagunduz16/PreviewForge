import { z } from "zod";

/**
 * GitHub's numeric identifiers are deliberately strings at the HTTP/event
 * boundary.  Converting a JSON number after it has crossed this boundary can
 * lose precision for large identifiers.
 */
const githubDecimalIdPattern = /^[1-9][0-9]*$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export const githubIdSchema = z.string().regex(githubDecimalIdPattern, {
  message: "GitHub IDs must be positive decimal strings",
});
export type GithubId = z.infer<typeof githubIdSchema>;

export const githubUserIdSchema = githubIdSchema;
export const githubInstallationIdSchema = githubIdSchema;
export const githubRepositoryIdSchema = githubIdSchema;
export const githubPullRequestIdSchema = githubIdSchema;

/**
 * GitHub's webhook JSON encodes IDs as numbers.  Accept those only while they
 * are exactly representable in JavaScript, then immediately normalize them to
 * the decimal-string representation used by every internal boundary.
 */
const githubWebhookIdSchema = z
  .union([
    githubIdSchema,
    z
      .number()
      .refine(Number.isInteger, "GitHub numeric IDs must be integers")
      .refine(Number.isSafeInteger, "GitHub numeric IDs must be safe integers")
      .positive(),
  ])
  .transform((value) => String(value));

const githubLoginSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("/") && !containsControlCharacter(value), {
    message: "GitHub logins cannot contain control characters or slashes",
  });

export const githubRepositoryFullNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[^/\s]+\/[^/\s]+$/, "Repository names must be owner/name");

export const gitCommitShaSchema = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]{40}$/i, "Commit SHA must contain exactly 40 hexadecimal characters");

export const pullRequestActionSchema = z.enum(["opened", "reopened", "synchronize", "closed"]);
export type PullRequestAction = z.infer<typeof pullRequestActionSchema>;

const sourceTimestampSchema = z.iso.datetime();

/** The safe user projection retained by the control plane. */
export const githubUserProjectionSchema = z
  .object({
    id: githubUserIdSchema,
    login: githubLoginSchema,
  })
  .strip();
export type GithubUserProjection = z.infer<typeof githubUserProjectionSchema>;
export const githubUserSchema = githubUserProjectionSchema;

/** The safe installation/account projection retained by the control plane. */
export const githubInstallationProjectionSchema = z
  .object({
    id: githubInstallationIdSchema,
    accountLogin: githubLoginSchema,
    accountType: z.enum(["User", "Organization"]),
  })
  .strip();
export type GithubInstallationProjection = z.infer<typeof githubInstallationProjectionSchema>;
export const githubInstallationSchema = githubInstallationProjectionSchema;

/**
 * A repository projection used by import.  It intentionally has no URLs,
 * permissions blobs, owner objects, hooks, or token-bearing fields.
 */
export const githubRepositoryProjectionSchema = z
  .object({
    id: githubRepositoryIdSchema,
    fullName: githubRepositoryFullNameSchema,
    private: z.boolean().optional(),
    defaultBranch: z.string().min(1).max(255).optional(),
  })
  .strip();
export type GithubRepositoryProjection = z.infer<typeof githubRepositoryProjectionSchema>;
export const githubRepositorySchema = githubRepositoryProjectionSchema;

/**
 * OAuth callback parameters are safe to pass around only as opaque values;
 * the exchanged access/refresh tokens are never part of a durable DTO.
 */
export const githubOAuthCallbackSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(2048),
  })
  .strip();
export type GithubOAuthCallback = z.infer<typeof githubOAuthCallbackSchema>;

/** Internal adapter input. Never persist or emit this parsed value. */
export const githubOAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    scope: z.string(),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
  })
  .strip();
export type GithubOAuthTokenResponse = z.infer<typeof githubOAuthTokenResponseSchema>;

/** Token metadata safe for durable storage; secret token values are omitted. */
export const githubOAuthTokenMetadataSchema = z
  .object({
    tokenType: z.string().min(1),
    scope: z.string(),
    expiresInSeconds: z.number().int().positive().nullable(),
    refreshTokenExpiresInSeconds: z.number().int().positive().nullable(),
  })
  .strip();
export type GithubOAuthTokenMetadata = z.infer<typeof githubOAuthTokenMetadataSchema>;

export function projectGithubOAuthToken(value: unknown): GithubOAuthTokenMetadata {
  const token = githubOAuthTokenResponseSchema.parse(value);
  return githubOAuthTokenMetadataSchema.parse({
    tokenType: token.token_type,
    scope: token.scope,
    expiresInSeconds: token.expires_in ?? null,
    refreshTokenExpiresInSeconds: token.refresh_token_expires_in ?? null,
  });
}

/**
 * Canonical relative POSIX path.  Leading `./` segments are harmless and are
 * normalized away; dot-dot segments, backslashes, and absolute paths are not
 * accepted because the value is later used to address a build context.
 */
export const relativePosixPathSchema = z
  .string()
  .min(1)
  .max(512)
  .transform((value) => value.replace(/^(?:\.\/)+/, ""))
  .refine((value) => {
    if (
      value.length === 0 ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("\u0000") ||
      containsControlCharacter(value)
    ) {
      return false;
    }

    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }, "Path must be a relative POSIX path without traversal");

export const dockerfilePathSchema = relativePosixPathSchema;

export const healthPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (
      !value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("?") ||
      value.includes("#") ||
      value.includes("\u0000") ||
      containsControlCharacter(value) ||
      value.includes("://")
    ) {
      return false;
    }

    const segments = value.split("/");
    return (
      value === "/" ||
      segments
        .slice(1)
        .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }, "Health check must be a path-only absolute URL path");

export const containerPortSchema = z.number().int().min(1).max(65_535);
export const projectImportSchema = z
  .object({
    repositoryId: githubRepositoryIdSchema,
    repositoryFullName: githubRepositoryFullNameSchema,
    dockerfilePath: dockerfilePathSchema,
    port: containerPortSchema,
    healthPath: healthPathSchema,
    installationId: githubInstallationIdSchema.optional(),
  })
  .strip();
export type ProjectImport = z.infer<typeof projectImportSchema>;
export const projectImportRequestSchema = projectImportSchema;
export type ProjectImportRequest = ProjectImport;

/** Raw GitHub pull_request webhook fields needed for the M2 boundary. */
export const githubPullRequestWebhookSchema = z
  .object({
    action: pullRequestActionSchema,
    number: z.number().int().positive(),
    installation: z
      .object({
        id: githubWebhookIdSchema,
      })
      .strip(),
    repository: z
      .object({
        id: githubWebhookIdSchema,
        full_name: githubRepositoryFullNameSchema,
      })
      .strip(),
    pull_request: z
      .object({
        id: githubWebhookIdSchema.optional(),
        number: z.number().int().positive().optional(),
        head: z
          .object({
            sha: gitCommitShaSchema,
          })
          .strip(),
        updated_at: sourceTimestampSchema,
      })
      .strip(),
  })
  .strip();
export type GithubPullRequestWebhook = z.infer<typeof githubPullRequestWebhookSchema>;
export const pullRequestWebhookPayloadSchema = githubPullRequestWebhookSchema;

/** Safe, normalized pull-request event consumed by webhook persistence. */
export const pullRequestEventSchema = z
  .object({
    action: pullRequestActionSchema,
    installationId: githubInstallationIdSchema,
    repositoryId: githubRepositoryIdSchema,
    repositoryFullName: githubRepositoryFullNameSchema,
    pullRequestId: githubPullRequestIdSchema.optional(),
    pullRequestNumber: z.number().int().positive(),
    commitSha: gitCommitShaSchema,
    sourceTimestamp: sourceTimestampSchema,
  })
  .strip();
export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;

export function normalizePullRequestWebhookPayload(value: unknown): PullRequestEvent {
  const payload = githubPullRequestWebhookSchema.parse(value);
  return pullRequestEventSchema.parse({
    action: payload.action,
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repositoryFullName: payload.repository.full_name,
    ...(payload.pull_request.id === undefined ? {} : { pullRequestId: payload.pull_request.id }),
    pullRequestNumber: payload.number,
    commitSha: payload.pull_request.head.sha,
    sourceTimestamp: payload.pull_request.updated_at,
  });
}

export const parsePullRequestWebhookPayload = normalizePullRequestWebhookPayload;
export const normalizeGithubPullRequestWebhook = normalizePullRequestWebhookPayload;
export const githubPullRequestEventSchema = pullRequestEventSchema;

/** Versioned, identifier-only deletion intent emitted for a closed PR. */
export const environmentDeletionRequestedSchema = z
  .object({
    eventId: z.uuid(),
    eventType: z.literal("environment.deletion-requested.v1"),
    occurredAt: sourceTimestampSchema,
    environmentId: z.uuid(),
    sourceTimestamp: sourceTimestampSchema,
    projectId: z.uuid().optional(),
    pullRequestId: z.uuid().optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    repositoryId: githubRepositoryIdSchema.optional(),
    repositoryFullName: githubRepositoryFullNameSchema.optional(),
    installationId: githubInstallationIdSchema.optional(),
    reason: z.literal("pull_request_closed").optional(),
  })
  .strip();
export type EnvironmentDeletionRequested = z.infer<typeof environmentDeletionRequestedSchema>;
export const environmentDeletionRequestedEventSchema = environmentDeletionRequestedSchema;
