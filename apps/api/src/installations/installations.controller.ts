import { Controller, Get, Inject, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request, Response } from "express";
// biome-ignore lint/style/useImportType: Nest decorator metadata requires the runtime service value.
import { AuthService, OAUTH_BINDING_COOKIE, SESSION_COOKIE } from "../auth/auth.service.js";
import { parseCookie } from "../security/cookies.js";

type RequestWithResponse = Request & { res: Response };

@Controller({ path: "installations/github", scope: Scope.REQUEST })
export class InstallationsController {
  @Inject(REQUEST)
  private readonly request!: RequestWithResponse;

  constructor(private readonly auth: AuthService) {}

  @Get("start")
  async start(): Promise<void> {
    const result = await this.auth.startInstallation(
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
    );
    this.request.res.setHeader(
      "set-cookie",
      this.auth.oauthBindingCookie(result.bindingCookieValue),
    );
    this.request.res.redirect(result.authorizationUrl);
  }

  @Get("callback")
  async callback(): Promise<void> {
    await this.auth.finishInstallation(
      this.request.query,
      parseCookie(this.request.headers.cookie, OAUTH_BINDING_COOKIE),
      parseCookie(this.request.headers.cookie, SESSION_COOKIE),
    );
    this.request.res.setHeader("set-cookie", this.auth.clearCookie(OAUTH_BINDING_COOKIE));
    this.request.res.redirect("/");
  }
}
