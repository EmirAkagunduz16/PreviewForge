import { Controller, Delete, Get, Inject, Put, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { SESSION_COOKIE } from "../auth/auth.service.js";
import { parseCookie } from "../security/cookies.js";
import { EnvironmentVariablesService } from "./environment-variables.service.js";

@Controller({ path: "projects/:projectId/environment-variables", scope: Scope.REQUEST })
export class EnvironmentVariablesController {
  @Inject(REQUEST) private readonly request!: Request;

  @Inject(EnvironmentVariablesService)
  private readonly service!: EnvironmentVariablesService;

  @Get()
  list() {
    const projectId = pathParameter(this.request.params.projectId);
    return this.service.list(parseCookie(this.request.headers.cookie, SESSION_COOKIE), projectId);
  }

  @Put(":key")
  put() {
    const projectId = pathParameter(this.request.params.projectId);
    const key = pathParameter(this.request.params.key);
    return this.service.put(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      header(this.request, "origin"),
      projectId,
      key,
      this.request.body,
    );
  }

  @Delete(":key")
  delete() {
    const projectId = pathParameter(this.request.params.projectId);
    const key = pathParameter(this.request.params.key);
    return this.service.delete(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
      header(this.request, "origin"),
      projectId,
      key,
    );
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function pathParameter(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
