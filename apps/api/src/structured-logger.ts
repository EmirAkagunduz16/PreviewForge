import type { LoggerService } from "@nestjs/common";

export type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger implements LoggerService {
  constructor(private readonly minimumLevel: LogLevel = "info") {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("info", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  event(
    level: LogLevel,
    event: string,
    attributes: Record<string, boolean | number | string>,
  ): void {
    this.writeRecord(level, { event, ...attributes });
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const context = optionalParams.find((value) => typeof value === "string");
    this.writeRecord(level, {
      message: normalizeMessage(message),
      ...(context ? { context } : {}),
    });
  }

  private writeRecord(level: LogLevel, fields: Record<string, unknown>): void {
    if (priorities[level] < priorities[this.minimumLevel]) {
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;

    if (level === "error" || level === "warn") {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }
}

function normalizeMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }

  if (message instanceof Error) {
    return message.message;
  }

  return "Application log event";
}
