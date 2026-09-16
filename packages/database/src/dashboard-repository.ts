import type { Prisma, PrismaClient } from "@prisma/client";

export type DashboardCursor = { createdAt: Date; id: string };
export type DashboardPageOptions = { limit: number; cursor?: DashboardCursor };

const projectSelect = {
  id: true,
  repositoryFullName: true,
  defaultBranch: true,
  dockerfilePath: true,
  containerPort: true,
  healthPath: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

const deploymentSelect = {
  id: true,
  attempt: true,
  commitSha: true,
  status: true,
  failureStage: true,
  failureCode: true,
  failureMessage: true,
  failureRetryable: true,
  imageDigest: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeploymentSelect;

/** Owner-scoped read projections for the M6 dashboard. */
export class DashboardRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async hasOwnedProject(ownerId: string, projectId: string): Promise<boolean> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    return project !== null;
  }

  async listProjects(ownerId: string, options: DashboardPageOptions) {
    const rows = await this.prisma.project.findMany({
      where: options.cursor ? projectCursorWhere(ownerId, options.cursor) : { ownerId },
      select: projectSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit + 1,
    });
    return page(rows, options.limit);
  }

  async listPreviews(ownerId: string, projectId: string, options: DashboardPageOptions) {
    const rows = await this.prisma.previewEnvironment.findMany({
      where: {
        project: { id: projectId, ownerId },
        status: "ACTIVE",
        ...(options.cursor ? environmentCursorWhere(options.cursor) : {}),
      },
      select: {
        id: true,
        projectId: true,
        previewKey: true,
        desiredCommitSha: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        pullRequest: {
          select: {
            id: true,
            number: true,
            title: true,
            headSha: true,
            state: true,
            updatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit + 1,
    });
    const selectedRows = rows.slice(0, options.limit);
    const pairs = selectedRows.map(({ id, desiredCommitSha }) => ({
      environmentId: id,
      commitSha: desiredCommitSha,
    }));
    const deployments = pairs.length
      ? await this.prisma.deployment.findMany({
          where: { OR: pairs },
          select: { ...deploymentSelect, environmentId: true },
          orderBy: [{ attempt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        })
      : [];
    const currentByEnvironment = new Map<string, (typeof deployments)[number]>();
    for (const deployment of deployments) {
      if (!currentByEnvironment.has(deployment.environmentId)) {
        currentByEnvironment.set(deployment.environmentId, deployment);
      }
    }
    return {
      items: selectedRows.map((environment) => {
        const current = currentByEnvironment.get(environment.id);
        const { environmentId: _environmentId, ...currentDeployment } = current ?? {};
        return { ...environment, currentDeployment: current ? currentDeployment : null };
      }),
      nextCursor:
        rows.length > options.limit && selectedRows.length > 0
          ? {
              id: selectedRows[selectedRows.length - 1]?.id as string,
              createdAt: selectedRows[selectedRows.length - 1]?.createdAt as Date,
            }
          : null,
    };
  }

  async listDeployments(ownerId: string, projectId: string, options: DashboardPageOptions) {
    const rows = await this.prisma.deployment.findMany({
      where: {
        environment: { project: { id: projectId, ownerId } },
        ...(options.cursor ? deploymentCursorWhere(options.cursor) : {}),
      },
      select: {
        ...deploymentSelect,
        environment: {
          select: {
            id: true,
            previewKey: true,
            desiredCommitSha: true,
            status: true,
            pullRequest: { select: { id: true, number: true, title: true, state: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit + 1,
    });
    return page(rows, options.limit);
  }

  async findDeployment(ownerId: string, deploymentId: string) {
    return this.prisma.deployment.findFirst({
      where: { id: deploymentId, environment: { project: { ownerId } } },
      select: {
        ...deploymentSelect,
        environment: {
          select: {
            id: true,
            projectId: true,
            previewKey: true,
            desiredCommitSha: true,
            status: true,
            expiresAt: true,
            pullRequest: {
              select: { id: true, number: true, title: true, headSha: true, state: true },
            },
            project: { select: { id: true, repositoryFullName: true } },
          },
        },
      },
    });
  }
}

function page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
  };
}

function environmentCursorWhere(cursor: DashboardCursor): Prisma.PreviewEnvironmentWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function deploymentCursorWhere(cursor: DashboardCursor): Prisma.DeploymentWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function projectCursorWhere(ownerId: string, cursor: DashboardCursor): Prisma.ProjectWhereInput {
  return {
    ownerId,
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}
