import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Creates the application's PostgreSQL-backed Prisma client.
 *
 * Prisma 7 requires a driver adapter for direct database connections. Keep
 * adapter construction here so API and worker callers share one runtime path
 * and never accidentally instantiate an unconfigured client.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (connectionString.trim().length === 0) {
    throw new Error("A database connection string is required");
  }

  return new PrismaClient({
    adapter: new PrismaPg(connectionString),
  });
}

export type { PrismaClient } from "@prisma/client";
