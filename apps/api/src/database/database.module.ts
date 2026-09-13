import type { DynamicModule, OnModuleDestroy } from "@nestjs/common";
import { Injectable, Module } from "@nestjs/common";
import { createPrismaClient, type PrismaClient } from "@previewforge/database";

export const DATABASE_CLIENT = Symbol("PREVIEWFORGE_DATABASE_CLIENT");

export type DatabaseModuleOptions = {
  connectionString?: string;
};

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(private readonly client: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    if (!options.connectionString) {
      return { module: DatabaseModule };
    }

    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DATABASE_CLIENT,
          useFactory: () => createPrismaClient(options.connectionString as string),
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
