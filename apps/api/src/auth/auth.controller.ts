import { Controller, Get, Inject, Post, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request, Response } from "express";
import { parseCookie } from "../security/cookies.js";
import { AuthService, OAUTH_BINDING_COOKIE, SESSION_COOKIE } from "./auth.service.js";

type RequestWithResponse = Request & { res: Response };

@Controller({ path: "auth/github", scope: Scope.REQUEST })
export class AuthController {
  @Inject(REQUEST)
  private readonly request!: RequestWithResponse;

  @Inject(AuthService)
  private readonly auth!: AuthService;

  @Get("start")
  async start(): Promise<void> {
    const result = await this.auth.startSignIn();
    this.request.res.setHeader(
      "set-cookie",
      this.auth.oauthBindingCookie(result.bindingCookieValue),
    );
    this.request.res.redirect(result.authorizationUrl);
  }

  @Get("callback")
  async callback(): Promise<void> {
    const result = await this.auth.finishSignIn(
      this.request.query,
      parseCookie(this.request.headers.cookie, OAUTH_BINDING_COOKIE),
    );
    this.request.res.setHeader("set-cookie", [
      this.auth.sessionCookie(result.sessionToken, result.sessionExpiresAt),
      this.auth.clearCookie(OAUTH_BINDING_COOKIE),
    ]);
    this.request.res.redirect("/");
  }

  @Post("logout")
  async logout(): Promise<void> {
    await this.auth.revoke(parseCookie(this.request.headers.cookie, SESSION_COOKIE));
    this.request.res.setHeader("set-cookie", this.auth.clearCookie(SESSION_COOKIE));
    this.request.res.status(204).send();
  }
}
