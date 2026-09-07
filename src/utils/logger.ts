export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  debug(message: string, metadata?: Record<string, unknown>): void {
    if (process.env.SHANNON_DEBUG === "1") {
      console.error(formatLog("debug", message, metadata));
    }
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    console.error(formatLog("info", message, metadata));
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    console.error(formatLog("warn", message, metadata));
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    console.error(formatLog("error", message, metadata));
  }
}

export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

function formatLog(
  level: string,
  message: string,
  metadata?: Record<string, unknown>,
): string {
  const suffix = metadata ? ` ${JSON.stringify(metadata)}` : "";
  return `[${level}] ${message}${suffix}`;
}
