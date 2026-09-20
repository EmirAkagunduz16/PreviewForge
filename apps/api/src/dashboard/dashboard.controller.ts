import { Controller, Get, Inject, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { SESSION_COOKIE } from "../auth/auth.service.js";
import { parseCookie } from "../security/cookies.js";
import { DashboardService } from "./dashboard.service.js";

@Controller({ path: "projects", scope: Scope.REQUEST })
export class DashboardProjectsController {
  @Inject(REQUEST)
  private readonly request!: Request;

  @Inject(DashboardService)
  private readonly dashboard!: DashboardService;

  @Get()
  listProjects() {
    return this.dashboard.listProjects(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      this.request.query,
    );
  }

  @Get(":projectId/previews")
  listPreviews() {
    return this.dashboard.listPreviews(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      pathParameter(this.request.params.projectId),
      this.request.query,
    );
  }

  @Get(":projectId/deployments")
  listDeployments() {
    return this.dashboard.listDeployments(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      pathParameter(this.request.params.projectId),
      this.request.query,
    );
  }
}

@Controller({ path: "deployments", scope: Scope.REQUEST })
export class DashboardDeploymentsController {
  @Inject(REQUEST)
  private readonly request!: Request;

  @Inject(DashboardService)
  private readonly dashboard!: DashboardService;

  @Get(":deploymentId")
  getDeployment() {
    return this.dashboard.getDeployment(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      pathParameter(this.request.params.deploymentId),
    );
  }
}

function pathParameter(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
