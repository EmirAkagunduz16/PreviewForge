import { Prisma, type PrismaClient } from "@prisma/client";

export type ProjectImportRecord = {
  id: string;
  installationId: string;
  ownerId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  dockerfilePath: string;
  containerPort: number;
  healthPath: string;
};

export type ProjectBuildRecord = {
  id: string;
  githubInstallationId: string;
  repositoryFullName: string;
  dockerfilePath: string;
  containerPort: number;
  healthPath: string;
};

export type ProjectImportInput = {
  installationId: string;
  ownerId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  defaultBranch?: string;
  dockerfilePath: string;
  containerPort: number;
  healthPath: string;
};

export class ProjectIdentityConflictError extends Error {
  override readonly name = "ProjectIdentityConflictError";

  constructor() {
    super("GitHub repository is already owned by another installation or user");
  }
}

/** PostgreSQL-backed idempotent project import operations. */
export class ProjectRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(projectId: string): Promise<ProjectImportRecord | null> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    return project === null ? null : toProject(project);
  }

  async findBuildById(projectId: string): Promise<ProjectBuildRecord | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        repositoryFullName: true,
        dockerfilePath: true,
        containerPort: true,
        healthPath: true,
        installation: { select: { githubInstallationId: true } },
      },
    });
    if (project === null) return null;
    return {
      id: project.id,
      githubInstallationId: project.installation.githubInstallationId.toString(),
      repositoryFullName: project.repositoryFullName,
      dockerfilePath: project.dockerfilePath,
      containerPort: project.containerPort,
      healthPath: project.healthPath,
    };
  }

  async importProject(input: ProjectImportInput): Promise<ProjectImportRecord> {
    const repositoryId = parseGitHubId(input.githubRepositoryId);
    const installation = await this.prisma.installation.findUnique({
      where: { id: input.installationId },
      select: { id: true, ownerId: true },
    });
    if (!installation || installation.ownerId !== input.ownerId) {
      throw new ProjectIdentityConflictError();
    }

    const data: Prisma.ProjectUncheckedCreateInput = {
      installationId: input.installationId,
      ownerId: input.ownerId,
      githubRepositoryId: repositoryId,
      repositoryFullName: input.repositoryFullName,
      defaultBranch: input.defaultBranch ?? "main",
      dockerfilePath: input.dockerfilePath,
      containerPort: input.containerPort,
      healthPath: input.healthPath,
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const byNumericId = await tx.project.findUnique({
          where: { githubRepositoryId: repositoryId },
        });
        if (byNumericId) return this.updateExisting(tx, byNumericId, input);

        // M1 projects did not have a repository ID. A verified import can
        // backfill that legacy row only when the installation/full name match.
        const legacy = await tx.project.findUnique({
          where: {
            installationId_repositoryFullName: {
              installationId: input.installationId,
              repositoryFullName: input.repositoryFullName,
            },
          },
        });
        if (legacy && legacy.githubRepositoryId === null) {
          return this.updateExisting(tx, legacy, input);
        }
        if (legacy) throw new ProjectIdentityConflictError();

        const created = await tx.project.create({ data });
        return toProject(created);
      });
    } catch (error) {
      // Concurrent imports race on the numeric repository unique index. The
      // winner is authoritative; apply the same immutable owner/install rule
      // after re-reading it instead of leaking a raw Prisma error.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.project.findUnique({
        where: { githubRepositoryId: repositoryId },
      });
      if (isRepositoryIdUniqueViolation(error) && existing) {
        return this.updateAfterRace(existing, input);
      }

      // A same-installation/full-name collision is a domain identity conflict,
      // not a numeric-ID race. Never leak its raw P2002/500 to the API.
      const conflictingName = await this.prisma.project.findUnique({
        where: {
          installationId_repositoryFullName: {
            installationId: input.installationId,
            repositoryFullName: input.repositoryFullName,
          },
        },
      });
      if (conflictingName) throw new ProjectIdentityConflictError();
      throw error;
    }
  }

  private async updateAfterRace(
    existing: ProjectRow,
    input: ProjectImportInput,
  ): Promise<ProjectImportRecord> {
    if (existing.ownerId !== input.ownerId || existing.installationId !== input.installationId) {
      throw new ProjectIdentityConflictError();
    }
    const updated = await this.prisma.project.update({
      where: { id: existing.id },
      data: projectUpdateData(input),
    });
    return toProject(updated);
  }

  private async updateExisting(
    tx: Prisma.TransactionClient,
    existing: ProjectRow,
    input: ProjectImportInput,
  ): Promise<ProjectImportRecord> {
    if (existing.ownerId !== input.ownerId || existing.installationId !== input.installationId) {
      throw new ProjectIdentityConflictError();
    }
    const updated = await tx.project.update({
      where: { id: existing.id },
      data: projectUpdateData(input),
    });
    return toProject(updated);
  }
}

type ProjectRow = {
  id: string;
  installationId: string;
  ownerId: string;
  githubRepositoryId: bigint | null;
  repositoryFullName: string;
  defaultBranch: string;
  dockerfilePath: string;
  containerPort: number;
  healthPath: string;
};

function projectUpdateData(input: ProjectImportInput): Prisma.ProjectUncheckedUpdateInput {
  return {
    // Setting the same numeric identity is a no-op for an already-imported
    // project and backfills the nullable identity on an M1 legacy row. The
    // database trigger rejects any attempt to change it afterwards.
    githubRepositoryId: parseGitHubId(input.githubRepositoryId),
    repositoryFullName: input.repositoryFullName,
    defaultBranch: input.defaultBranch ?? "main",
    dockerfilePath: input.dockerfilePath,
    containerPort: input.containerPort,
    healthPath: input.healthPath,
  };
}

function toProject(row: ProjectRow): ProjectImportRecord {
  if (row.githubRepositoryId === null) {
    throw new Error("Imported project is missing its GitHub repository identity");
  }
  return {
    id: row.id,
    installationId: row.installationId,
    ownerId: row.ownerId,
    githubRepositoryId: row.githubRepositoryId.toString(),
    repositoryFullName: row.repositoryFullName,
    defaultBranch: row.defaultBranch,
    dockerfilePath: row.dockerfilePath,
    containerPort: row.containerPort,
    healthPath: row.healthPath,
  };
}

function parseGitHubId(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("GitHub repository ID must be positive");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new Error("GitHub repository ID exceeds PostgreSQL BIGINT range");
  }
  return parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRepositoryIdUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.some((item) => String(item).includes("github_repository_id"));
  }
  return typeof target === "string" && target.includes("github_repository_id");
}
