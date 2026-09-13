import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { InstallationsController } from "../installations/installations.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import type {
  AuthRepository,
  AuthRuntimeConfig,
  CredentialCipherLike,
  GitHubAuthAdapter,
} from "./auth.types.js";

export const AUTH_REPOSITORY = Symbol("PREVIEWFORGE_AUTH_REPOSITORY");
export const AUTH_GITHUB_CLIENT = Symbol("PREVIEWFORGE_AUTH_GITHUB_CLIENT");
export const AUTH_CREDENTIAL_CIPHER = Symbol("PREVIEWFORGE_AUTH_CREDENTIAL_CIPHER");
export const AUTH_RUNTIME_CONFIG = Symbol("PREVIEWFORGE_AUTH_RUNTIME_CONFIG");

export type AuthModuleOptions = {
  repository: AuthRepository;
  github: GitHubAuthAdapter;
  cipher: CredentialCipherLike;
  config: AuthRuntimeConfig;
};

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest modules expose a static dynamic-module factory.
export class AuthModule {
  static register(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController, InstallationsController],
      providers: [
        { provide: AUTH_REPOSITORY, useValue: options.repository },
        { provide: AUTH_GITHUB_CLIENT, useValue: options.github },
        { provide: AUTH_CREDENTIAL_CIPHER, useValue: options.cipher },
        { provide: AUTH_RUNTIME_CONFIG, useValue: options.config },
        {
          provide: AuthService,
          useFactory: (
            repository: AuthRepository,
            github: GitHubAuthAdapter,
            cipher: CredentialCipherLike,
            config: AuthRuntimeConfig,
          ) => new AuthService(repository, github, cipher, config),
          inject: [
            AUTH_REPOSITORY,
            AUTH_GITHUB_CLIENT,
            AUTH_CREDENTIAL_CIPHER,
            AUTH_RUNTIME_CONFIG,
          ],
        },
      ],
      exports: [AuthService],
    };
  }
}
