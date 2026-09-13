import { z } from "zod";

const portSchema = z
  .string()
  .regex(/^\d+$/, "must contain only digits")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65_535));

const environmentSchema = z.object({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: portSchema.default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ApiConfig = {
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
  nodeEnv: "development" | "test" | "production";
  port: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const reasons = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid API configuration: ${reasons}`);
  }

  return {
    host: result.data.API_HOST,
    logLevel: result.data.LOG_LEVEL,
    nodeEnv: result.data.NODE_ENV,
    port: result.data.API_PORT,
  };
}
