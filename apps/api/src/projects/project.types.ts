import type { GithubRepositoryProjection } from "@previewforge/contracts";
import type { InstallationRecord, ProjectImportRecord } from "@previewforge/database";

export type ProjectSession = { userId: string };

export type ProjectRepositoryCandidate = GithubRepositoryProjection & {
  /** GitHub's user-installation response exposes this permission bit. */
  pull?: boolean;
};

export interface ProjectAuthPort {
  authenticate(sessionToken: string | undefined): Promise<ProjectSession>;
}

export interface ProjectInstallationPort {
  findInstallation(githubInstallationId: string): Promise<InstallationRecord | null>;
  getCredential(userId: string): Promise<{ encryptedAccessToken: string } | null>;
}

export interface ProjectGitHubPort {
  listUserInstallationRepositories(
    installationId: string,
    userToken: string,
  ): Promise<ProjectRepositoryCandidate[]>;
  createInstallationToken(
    installationId: string,
  ): Promise<{ accessToken: string; expiresAt?: string }>;
  getRepositoryContent(
    owner: string,
    repository: string,
    path: string,
    installationToken: string,
  ): Promise<{ type: string; path: string } | Array<{ type: string; path: string }>>;
}

export interface ProjectRepositoryPort {
  importProject(input: {
    installationId: string;
    ownerId: string;
    githubRepositoryId: string;
    repositoryFullName: string;
    defaultBranch?: string;
    dockerfilePath: string;
    containerPort: number;
    healthPath: string;
  }): Promise<ProjectImportRecord>;
}

export interface ProjectCredentialCipher {
  decrypt(value: string, associatedData?: string): string;
}

export type ProjectRepositoryView = Omit<ProjectImportRecord, "installationId" | "ownerId">;
