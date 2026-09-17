import type { PrismaClient } from "./prisma-client.js";

const MAX_PROJECT_VARIABLES = 32;

export type ProjectEnvironmentVariableRecord = {
  key: string;
  encryptedValue: string;
  createdAt: Date;
  updatedAt: Date;
};

export class ProjectEnvironmentLimitError extends Error {
  constructor() {
    super("Project environment variable key limit exceeded");
  }
}

export class ProjectEnvironmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listNames(ownerId: string, projectId: string) {
    const rows = await this.prisma.projectEnvironmentVariable.findMany({
      where: { projectId, project: { ownerId } },
      select: { key: true },
      orderBy: { key: "asc" },
    });
    return rows;
  }

  async countNames(ownerId: string, projectId: string): Promise<number> {
    return this.prisma.projectEnvironmentVariable.count({
      where: { projectId, project: { ownerId } },
    });
  }

  async hasOwnedProject(ownerId: string, projectId: string): Promise<boolean> {
    return (await this.prisma.project.count({ where: { id: projectId, ownerId } })) > 0;
  }

  async upsert(ownerId: string, projectId: string, key: string, encryptedValue: string) {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true },
      });
      if (!project) return null;
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
      const existing = await tx.projectEnvironmentVariable.findUnique({
        where: { projectId_key: { projectId, key } },
        select: { id: true },
      });
      if (
        !existing &&
        (await tx.projectEnvironmentVariable.count({ where: { projectId } })) >=
          MAX_PROJECT_VARIABLES
      ) {
        throw new ProjectEnvironmentLimitError();
      }
      return tx.projectEnvironmentVariable.upsert({
        where: { projectId_key: { projectId, key } },
        create: { projectId, key, encryptedValue },
        update: { encryptedValue },
        select: { key: true },
      });
    });
  }

  async delete(ownerId: string, projectId: string, key: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true },
      });
      if (!project) return false;
      const removed = await tx.projectEnvironmentVariable.deleteMany({ where: { projectId, key } });
      return removed.count > 0;
    });
  }

  async listEncryptedByProjectId(projectId: string): Promise<ProjectEnvironmentVariableRecord[]> {
    return this.prisma.projectEnvironmentVariable.findMany({
      where: { projectId },
      select: { key: true, encryptedValue: true, createdAt: true, updatedAt: true },
      orderBy: { key: "asc" },
    });
  }

  async findPreviewExpiryByEnvironmentId(environmentId: string): Promise<Date | null> {
    const environment = await this.prisma.previewEnvironment.findUnique({
      where: { id: environmentId },
      select: { expiresAt: true },
    });
    return environment?.expiresAt ?? null;
  }
}
