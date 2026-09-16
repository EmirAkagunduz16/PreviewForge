import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { DashboardCursor, DashboardPageOptions } from "@previewforge/database";
import type { ProjectAuthPort } from "../projects/project.types.js";
import type { DashboardRepositoryPort } from "./dashboard.types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

@Injectable()
export class DashboardService {
  constructor(
    private readonly auth: ProjectAuthPort,
    private readonly dashboard: DashboardRepositoryPort,
  ) {}

  async listProjects(sessionToken: string | undefined, query: unknown) {
    const { userId } = await this.auth.authenticate(sessionToken);
    return encodePage(await this.dashboard.listProjects(userId, parsePageOptions(query)));
  }

  async listPreviews(sessionToken: string | undefined, projectId: string, query: unknown) {
    const { userId } = await this.auth.authenticate(sessionToken);
    const id = parseUuid(projectId, "projectId");
    if (!(await this.dashboard.hasOwnedProject(userId, id))) throw new NotFoundException();
    return encodePage(await this.dashboard.listPreviews(userId, id, parsePageOptions(query)));
  }

  async listDeployments(sessionToken: string | undefined, projectId: string, query: unknown) {
    const { userId } = await this.auth.authenticate(sessionToken);
    const id = parseUuid(projectId, "projectId");
    if (!(await this.dashboard.hasOwnedProject(userId, id))) throw new NotFoundException();
    return encodePage(await this.dashboard.listDeployments(userId, id, parsePageOptions(query)));
  }

  async getDeployment(sessionToken: string | undefined, deploymentId: string) {
    const { userId } = await this.auth.authenticate(sessionToken);
    const deployment = await this.dashboard.findDeployment(
      userId,
      parseUuid(deploymentId, "deploymentId"),
    );
    if (!deployment) throw new NotFoundException();
    return deployment;
  }
}

function parsePageOptions(value: unknown): DashboardPageOptions {
  const query = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const limitValue = query.limit;
  let limit = DEFAULT_LIMIT;
  if (limitValue !== undefined) {
    if (typeof limitValue !== "string" || !/^[1-9][0-9]*$/u.test(limitValue)) {
      throw new BadRequestException("limit must be a positive integer");
    }
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must not exceed ${MAX_LIMIT}`);
    }
  }
  const cursorValue = query.cursor;
  if (cursorValue === undefined) return { limit };
  if (typeof cursorValue !== "string" || cursorValue.length > 512) {
    throw new BadRequestException("cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8")) as {
      id?: unknown;
      createdAt?: unknown;
    };
    if (
      typeof decoded.id !== "string" ||
      !UUID_PATTERN.test(decoded.id) ||
      typeof decoded.createdAt !== "string" ||
      !Number.isFinite(Date.parse(decoded.createdAt))
    ) {
      throw new Error("invalid cursor fields");
    }
    return { limit, cursor: { id: decoded.id, createdAt: new Date(decoded.createdAt) } };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}

function parseUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new BadRequestException(`${field} must be a UUID`);
  return value;
}

function encodePage<T extends { nextCursor: DashboardCursor | null }>(page: T) {
  return {
    ...page,
    nextCursor: page.nextCursor
      ? Buffer.from(
          JSON.stringify({
            id: page.nextCursor.id,
            createdAt: page.nextCursor.createdAt.toISOString(),
          }),
        ).toString("base64url")
      : null,
  };
}
