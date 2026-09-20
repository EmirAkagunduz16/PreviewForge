import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { loadPreviewUrlConfig } from "@previewforge/contracts";
import {
  AuthInstallationRepository,
  createPrismaClient,
  DashboardRepository,
  LogChunkRepository,
  ProjectEnvironmentRepository,
  ProjectRepository,
  WebhookRepository,
} from "@previewforge/database";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { type ApiConfig, DEFAULT_PREVIEW_TTL_SECONDS } from "./config.js";
import {
  DASHBOARD_AUTH,
  DASHBOARD_REPOSITORY,
  DashboardDeploymentsController,
  DashboardProjectsController,
  DashboardService,
} from "./dashboard/index.js";
import { DatabaseModule } from "./database/database.module.js";
import {
  EnvironmentVariablesController,
  EnvironmentVariablesService,
} from "./environment-variables/index.js";
import { GitHubClient } from "./github/github-client.js";
import { HealthController } from "./health.controller.js";
import { InstallationsController } from "./installations/installations.controller.js";
import {
  LIVE_OUTPUT_AUTH,
  LIVE_OUTPUT_DASHBOARD,
  LIVE_OUTPUT_LOGS,
  LiveOutputController,
  LiveOutputService,
} from "./live-output/index.js";
import { NotFoundController } from "./not-found.controller.js";
import {
  PROJECT_AUTH,
  PROJECT_CREDENTIAL_CIPHER,
  PROJECT_GITHUB,
  PROJECT_INSTALLATION_REPOSITORY,
  PROJECT_REPOSITORY,
  ProjectService,
  ProjectsController,
} from "./projects/index.js";
import { CredentialCipher } from "./security/credential-cipher.js";
import {
  GITHUB_WEBHOOK_REPOSITORY,
  GITHUB_WEBHOOK_SECRET,
  GithubWebhookController,
  GithubWebhookService,
} from "./webhooks/index.js";

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest modules expose a static dynamic-module factory.
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    const runtime = m2Runtime(config);
    if (!runtime) {
      return {
        module: AppModule,
        controllers: [HealthController, NotFoundController],
      };
    }

    const prisma = createPrismaClient(runtime.databaseUrl);
    const github = new GitHubClient({
      appId: runtime.github.appId,
      clientId: runtime.github.clientId,
      clientSecret: runtime.github.clientSecret,
      privateKey: runtime.github.privateKey,
      apiBaseUrl: runtime.github.apiBaseUrl,
      oauthBaseUrl: runtime.github.oauthBaseUrl,
    });
    const cipher = new CredentialCipher(runtime.encryptionKey);
    const authRepository = new AuthInstallationRepository(prisma);
    const projectRepository = new ProjectRepository(prisma);
    const dashboardRepository = new DashboardRepository(prisma);
    const logChunkRepository = new LogChunkRepository(prisma);
    const environmentVariablesRepository = new ProjectEnvironmentRepository(prisma);
    const webhookRepository = new WebhookRepository(prisma, {
      previewTtlSeconds: runtime.previewTtlSeconds,
    });
    const previewUrlConfig = loadPreviewUrlConfig(process.env, config.nodeEnv);

    return {
      module: AppModule,
      imports: [DatabaseModule.forRoot({ client: prisma })],
      controllers: [
        HealthController,
        AuthController,
        InstallationsController,
        ProjectsController,
        DashboardProjectsController,
        DashboardDeploymentsController,
        LiveOutputController,
        EnvironmentVariablesController,
        GithubWebhookController,
        NotFoundController,
      ],
      providers: [
        {
          provide: AuthService,
          useFactory: () =>
            new AuthService(authRepository, github, cipher, {
              clientId: runtime.github.clientId,
              appSlug: runtime.github.appSlug,
              oauthBaseUrl: runtime.github.oauthBaseUrl,
              publicBaseUrl: runtime.publicBaseUrl,
              sessionTtlSeconds: runtime.sessionTtlSeconds,
              oauthStateTtlSeconds: runtime.oauthStateTtlSeconds,
            }),
        },
        { provide: PROJECT_AUTH, useExisting: AuthService },
        { provide: DASHBOARD_AUTH, useExisting: AuthService },
        { provide: DASHBOARD_REPOSITORY, useValue: dashboardRepository },
        { provide: LIVE_OUTPUT_AUTH, useExisting: AuthService },
        { provide: LIVE_OUTPUT_DASHBOARD, useValue: dashboardRepository },
        { provide: LIVE_OUTPUT_LOGS, useValue: logChunkRepository },
        {
          provide: LiveOutputService,
          inject: [LIVE_OUTPUT_AUTH, LIVE_OUTPUT_DASHBOARD, LIVE_OUTPUT_LOGS],
          useFactory: (...dependencies: ConstructorParameters<typeof LiveOutputService>) =>
            new LiveOutputService(...dependencies),
        },
        {
          provide: EnvironmentVariablesService,
          inject: [AuthService],
          useFactory: (auth: AuthService) =>
            new EnvironmentVariablesService(
              auth,
              environmentVariablesRepository,
              cipher,
              runtime.publicBaseUrl,
            ),
        },
        {
          provide: DashboardService,
          inject: [DASHBOARD_AUTH, DASHBOARD_REPOSITORY],
          useFactory: (...dependencies: ConstructorParameters<typeof DashboardService>) =>
            new DashboardService(dependencies[0], dependencies[1], previewUrlConfig),
        },
        { provide: PROJECT_INSTALLATION_REPOSITORY, useValue: authRepository },
        { provide: PROJECT_GITHUB, useValue: github },
        { provide: PROJECT_REPOSITORY, useValue: projectRepository },
        { provide: PROJECT_CREDENTIAL_CIPHER, useValue: cipher },
        {
          provide: ProjectService,
          inject: [
            PROJECT_AUTH,
            PROJECT_INSTALLATION_REPOSITORY,
            PROJECT_GITHUB,
            PROJECT_REPOSITORY,
            PROJECT_CREDENTIAL_CIPHER,
          ],
          useFactory: (...dependencies: ConstructorParameters<typeof ProjectService>) =>
            new ProjectService(...dependencies),
        },
        { provide: GITHUB_WEBHOOK_REPOSITORY, useValue: webhookRepository },
        { provide: GITHUB_WEBHOOK_SECRET, useValue: runtime.github.webhookSecret },
        {
          provide: GithubWebhookService,
          inject: [GITHUB_WEBHOOK_REPOSITORY, GITHUB_WEBHOOK_SECRET],
          useFactory: (...dependencies: ConstructorParameters<typeof GithubWebhookService>) =>
            new GithubWebhookService(...dependencies),
        },
      ],
    };
  }
}

type M2Runtime = Required<
  Pick<
    ApiConfig,
    | "databaseUrl"
    | "github"
    | "encryptionKey"
    | "publicBaseUrl"
    | "sessionTtlSeconds"
    | "oauthStateTtlSeconds"
  >
> & { previewTtlSeconds: number };

function m2Runtime(config: ApiConfig): M2Runtime | undefined {
  const values = [
    config.databaseUrl,
    config.github,
    config.encryptionKey,
    config.publicBaseUrl,
    config.sessionTtlSeconds,
    config.oauthStateTtlSeconds,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error("Incomplete M2 runtime configuration");
  }
  return {
    ...config,
    previewTtlSeconds: config.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS,
  } as ApiConfig & M2Runtime;
}
