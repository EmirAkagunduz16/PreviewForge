import type { DynamicModule, OnModuleDestroy } from "@nestjs/common";
import { Injectable, Module } from "@nestjs/common";
import { createPrismaClient, type PrismaClient } from "@previewforge/database";

export const DATABASE_CLIENT = Symbol("PREVIEWFORGE_DATABASE_CLIENT");

export type DatabaseModuleOptions = {
  connectionString?: string;
  client?: PrismaClient;
};

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(private readonly client: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest modules expose a static dynamic-module factory.
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    if (options.connectionString && options.client) {
      throw new Error("Configure either a database connection string or a client, not both");
    }
    if (!options.connectionString && !options.client) {
      return { module: DatabaseModule };
    }

    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DATABASE_CLIENT,
          useFactory: () =>
            options.client ?? createPrismaClient(options.connectionString as string),
        },
        {
          provide: DatabaseLifecycle,
          inject: [DATABASE_CLIENT],
          useFactory: (client: PrismaClient) => new DatabaseLifecycle(client),
        },
      ],
      exports: [DATABASE_CLIENT],
    };
  }
}

export type { PrismaClient };
