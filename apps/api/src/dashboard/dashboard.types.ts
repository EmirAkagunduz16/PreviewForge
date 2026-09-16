import type { DashboardCursor, DashboardPageOptions } from "@previewforge/database";

type DashboardPage<T> = { items: T[]; nextCursor: DashboardCursor | null };

export interface DashboardRepositoryPort {
  hasOwnedProject(ownerId: string, projectId: string): Promise<boolean>;
  listProjects(ownerId: string, options: DashboardPageOptions): Promise<DashboardPage<unknown>>;
  listPreviews(
    ownerId: string,
    projectId: string,
    options: DashboardPageOptions,
  ): Promise<DashboardPage<unknown>>;
  listDeployments(
    ownerId: string,
    projectId: string,
    options: DashboardPageOptions,
  ): Promise<DashboardPage<unknown>>;
  findDeployment(ownerId: string, deploymentId: string): Promise<unknown | null>;
}
