import { BadRequestException, Controller, Get, Inject, Post, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { SESSION_COOKIE } from "../auth/auth.service.js";
import { parseCookie } from "../security/cookies.js";
import { ProjectImportError } from "./project.errors.js";
// biome-ignore lint/style/useImportType: Nest decorator metadata requires the runtime service value.
import { ProjectService } from "./project.service.js";

@Controller({ path: "projects", scope: Scope.REQUEST })
export class ProjectsController {
  @Inject(REQUEST)
  private readonly request!: Request;

  constructor(private readonly projects: ProjectService) {}

  @Get("repositories")
  listRepositories() {
    const installationId = queryValue(this.request.query.installation_id);
    if (!installationId) throw new BadRequestException("installation_id is required");
    return this.projects.listRepositories(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      installationId,
    );
  }

  @Post("import")
  async importProject() {
    try {
      return await this.projects.importProject(
        parseCookie(this.request.headers.cookie, SESSION_COOKIE),
        this.request.body,
      );
    } catch (error) {
      if (error instanceof ProjectImportError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

function queryValue(value: unknown): string | undefined {
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  return undefined;
}
