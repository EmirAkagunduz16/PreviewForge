import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { projectImportRequestSchema } from "@previewforge/contracts";
import { ProjectImportError } from "./project.errors.js";
import type {
  ProjectAuthPort,
  ProjectCredentialCipher,
  ProjectGitHubPort,
  ProjectInstallationPort,
  ProjectRepositoryCandidate,
  ProjectRepositoryPort,
} from "./project.types.js";

@Injectable()
export class ProjectService {
  constructor(
    private readonly auth: ProjectAuthPort,
    private readonly installations: ProjectInstallationPort,
    private readonly github: ProjectGitHubPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly cipher: ProjectCredentialCipher,
  ) {}

  async listRepositories(sessionToken: string | undefined, installationId: string) {
    const session = await this.auth.authenticate(sessionToken);
    const installation = await this.requireInstallation(installationId, session.userId);
    let userToken = await this.userToken(session.userId);
    try {
      return await this.github.listUserInstallationRepositories(
        installation.githubInstallationId,
        userToken,
      );
    } finally {
      // Keep the short-lived plaintext token scoped to the adapter call. It is
      // never returned, persisted, or sent to the logger.
      userToken = "";
    }
  }

  async importProject(sessionToken: string | undefined, value: unknown) {
    const session = await this.auth.authenticate(sessionToken);
    const parsed = projectImportRequestSchema.safeParse(value);
    if (!parsed.success || !parsed.data.installationId) {
      throw new BadRequestException({
        code: "INVALID_PROJECT_IMPORT",
        message: "Invalid project import request",
      });
    }
    const input = parsed.data;
    const installationId = input.installationId;
    if (!installationId) {
      throw new BadRequestException({
        code: "INVALID_PROJECT_IMPORT",
        message: "Invalid project import request",
      });
    }
    const installation = await this.requireInstallation(installationId, session.userId);
    let userToken = await this.userToken(session.userId);
    let repository: ProjectRepositoryCandidate | undefined;
    try {
      const repositories = await this.github.listUserInstallationRepositories(
        installation.githubInstallationId,
        userToken,
      );
      repository = matchRepository(repositories, input.repositoryId, input.repositoryFullName);
    } finally {
      userToken = "";
    }

    if (!repository) {
      throw new ProjectImportError("Repository is not accessible", "REPOSITORY_NOT_ACCESSIBLE");
    }
    const [owner, name] = splitFullName(repository.fullName);
    // The installation token is created only after user-scoped access and the
    // numeric/full-name identity have been revalidated above.
    let installationToken = (
      await this.github.createInstallationToken(installation.githubInstallationId)
    ).accessToken;
    try {
      const content = await this.github.getRepositoryContent(
        owner,
        name,
        input.dockerfilePath,
        installationToken,
      );
      assertDockerfileContent(content, input.dockerfilePath);
    } catch (error) {
      if (error instanceof ProjectImportError) throw error;
      if (isNotFoundError(error)) {
        throw new ProjectImportError("Dockerfile was not found", "DOCKERFILE_NOT_FOUND");
      }
      throw new ProjectImportError("Dockerfile could not be verified", "DOCKERFILE_CHECK_FAILED");
    } finally {
      // Never put this token in a project record or response. The adapter owns
      // the HTTP request and the local variable is cleared immediately after.
      installationToken = "";
    }

    try {
      return await this.projects.importProject({
        installationId: installation.id,
        ownerId: session.userId,
        githubRepositoryId: repository.id,
        repositoryFullName: repository.fullName,
        ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}),
        dockerfilePath: input.dockerfilePath,
        containerPort: input.port,
        healthPath: input.healthPath,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ProjectIdentityConflictError") {
        throw new ProjectImportError(
          "Repository identity conflicts with an existing project",
          "REPOSITORY_IDENTITY_CONFLICT",
        );
      }
      throw error;
    }
  }

  private async requireInstallation(installationId: string, userId: string) {
    const installation = await this.installations.findInstallation(installationId);
    if (!installation || installation.ownerId !== userId) {
      throw new UnauthorizedException("Installation access required");
    }
    return installation;
  }

  private async userToken(userId: string): Promise<string> {
    const credential = await this.installations.getCredential(userId);
    if (!credential) throw new UnauthorizedException("GitHub sign-in required");
    try {
      return this.cipher.decrypt(credential.encryptedAccessToken);
    } catch {
      throw new UnauthorizedException("GitHub sign-in required");
    }
  }
}

function matchRepository(
  repositories: Awaited<ReturnType<ProjectGitHubPort["listUserInstallationRepositories"]>>,
  requestedId: string,
  requestedFullName: string,
) {
  const byId = repositories.find((repository) => repository.id === requestedId);
  const byName = repositories.find((repository) => repository.fullName === requestedFullName);
  if (!byId || !byName || byId.id !== byName.id || byId.fullName !== byName.fullName) {
    throw new ProjectImportError(
      "Repository is not accessible or its identity changed",
      byId && byId.fullName !== requestedFullName
        ? "REPOSITORY_IDENTITY_CONFLICT"
        : "REPOSITORY_NOT_ACCESSIBLE",
    );
  }
  if (byId.pull === false) {
    throw new ProjectImportError(
      "Repository contents are not accessible",
      "REPOSITORY_NOT_ACCESSIBLE",
    );
  }
  return byId;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.code === "not_found";
}

function splitFullName(fullName: string): [string, string] {
  const separator = fullName.indexOf("/");
  if (separator <= 0 || separator === fullName.length - 1) {
    throw new ProjectImportError("Repository name is invalid", "INVALID_REPOSITORY_NAME");
  }
  return [fullName.slice(0, separator), fullName.slice(separator + 1)];
}

function assertDockerfileContent(
  content: { type: string; path: string } | Array<{ type: string; path: string }>,
  requestedPath: string,
): void {
  if (Array.isArray(content)) {
    throw new ProjectImportError("Dockerfile path resolves to a directory", "DOCKERFILE_NOT_FILE");
  }
  if (content.type !== "file") {
    throw new ProjectImportError("Dockerfile path is not a file", "DOCKERFILE_NOT_FILE");
  }
  if (content.path !== requestedPath) {
    throw new ProjectImportError(
      "Dockerfile response path does not match request",
      "DOCKERFILE_PATH_MISMATCH",
    );
  }
}
