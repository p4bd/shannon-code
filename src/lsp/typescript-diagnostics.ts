import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../tools/result.js";
import type { Logger } from "../utils/logger.js";
import { NoopLogger } from "../utils/logger.js";
import type {
  Diagnostic,
  DiagnosticsResult,
  DiagnosticsRunner,
} from "./diagnostics.js";

export interface TypeScriptDiagnosticsConfig {
  enabled: boolean;
  command: string;
  args: string[];
  timeoutMs: number;
  maxDiagnostics: number;
}

const DEFAULT_CONFIG: TypeScriptDiagnosticsConfig = {
  enabled: true,
  command: "npx",
  args: ["tsc", "--noEmit"],
  timeoutMs: 30_000,
  maxDiagnostics: 50,
};

export class TypeScriptDiagnosticsRunner implements DiagnosticsRunner {
  private readonly logger: Logger;

  constructor(
    private readonly config: TypeScriptDiagnosticsConfig = DEFAULT_CONFIG,
    logger?: Logger,
  ) {
    this.logger = logger ?? new NoopLogger();
  }

  async runAfterTool(input: {
    toolName: string;
    toolInput: unknown;
    toolResult: ToolResult;
    cwd: string;
  }): Promise<DiagnosticsResult | undefined> {
    if (!this.config.enabled || !input.toolResult.ok) {
      return undefined;
    }

    if (input.toolName !== "write_file" && input.toolName !== "edit_file") {
      return undefined;
    }

    const changedPath = getToolInputPath(input.toolInput);
    if (!changedPath || !isTypeScriptRelevantPath(changedPath)) {
      return undefined;
    }

    if (!(await isTypeScriptProject(input.cwd))) {
      return undefined;
    }

    return runTypeScriptDiagnostics({
      cwd: input.cwd,
      config: this.config,
      logger: this.logger,
    });
  }
}

export async function loadTypeScriptDiagnosticsConfig(
  cwd: string,
): Promise<TypeScriptDiagnosticsConfig> {
  const configPath = resolve(cwd, ".agent", "diagnostics.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return DEFAULT_CONFIG;
    }

    throw error;
  }

  return parseTypeScriptDiagnosticsConfig(JSON.parse(raw));
}

export function parseTypeScriptDiagnosticsConfig(
  value: unknown,
): TypeScriptDiagnosticsConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_CONFIG;
  }

  const record = value as Record<string, unknown>;
  const source =
    record.typescript && typeof record.typescript === "object"
      ? (record.typescript as Record<string, unknown>)
      : record;

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
    command:
      typeof source.command === "string" && source.command.trim().length > 0
        ? source.command
        : DEFAULT_CONFIG.command,
    args: Array.isArray(source.args)
      ? source.args.filter((arg): arg is string => typeof arg === "string")
      : DEFAULT_CONFIG.args,
    timeoutMs:
      typeof source.timeoutMs === "number" && source.timeoutMs > 0
        ? Math.trunc(source.timeoutMs)
        : DEFAULT_CONFIG.timeoutMs,
    maxDiagnostics:
      typeof source.maxDiagnostics === "number" && source.maxDiagnostics > 0
        ? Math.trunc(source.maxDiagnostics)
        : DEFAULT_CONFIG.maxDiagnostics,
  };
}

export async function runTypeScriptDiagnostics(input: {
  cwd: string;
  config?: TypeScriptDiagnosticsConfig;
  logger?: Logger;
}): Promise<DiagnosticsResult> {
  const config = input.config ?? DEFAULT_CONFIG;
  const commandText = [config.command, ...config.args].join(" ");
  const logger = input.logger ?? new NoopLogger();

  return new Promise((resolveResult) => {
    const spawnCommand = getSpawnCommand(config.command, config.args);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: DiagnosticsResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };

    const timeout = setTimeout(() => {
      logger.warn("TypeScript diagnostics timed out.", {
        command: commandText,
        timeoutMs: config.timeoutMs,
      });
      child.kill();
      finish({
        status: "failed",
        command: commandText,
        diagnostics: [],
        message: `TypeScript diagnostics timed out after ${config.timeoutMs}ms.`,
      });
    }, config.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      logger.warn("TypeScript diagnostics failed to start.", {
        command: commandText,
        error: error.message,
      });
      finish({
        status: "failed",
        command: commandText,
        diagnostics: [],
        message: error.message,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      const rawOutput = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
      const diagnostics = parseTypeScriptDiagnostics(
        rawOutput,
        config.maxDiagnostics,
      );

      if (diagnostics.length > 0) {
        finish({
          status: "diagnostics",
          command: commandText,
          exitCode,
          diagnostics,
          rawOutput,
        });
        return;
      }

      if (exitCode === 0) {
        finish({
          status: "ok",
          command: commandText,
          exitCode,
          diagnostics: [],
          rawOutput,
        });
        return;
      }

      finish({
        status: "failed",
        command: commandText,
        exitCode,
        diagnostics: [],
        message: rawOutput || `Command exited with code ${exitCode}.`,
        rawOutput,
      });
    });
  });
}

export function parseTypeScriptDiagnostics(
  output: string,
  maxDiagnostics = DEFAULT_CONFIG.maxDiagnostics,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern =
    /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (!match) {
      continue;
    }

    diagnostics.push({
      file: normalizeDiagnosticPath(match[1] ?? ""),
      line: Number(match[2]),
      character: Number(match[3]),
      severity: match[4] === "warning" ? "warning" : "error",
      code: match[5] ?? "TS0000",
      message: match[6] ?? "",
    });

    if (diagnostics.length >= maxDiagnostics) {
      break;
    }
  }

  return diagnostics;
}

export function appendDiagnosticsToToolResult(
  result: ToolResult,
  diagnostics: DiagnosticsResult | undefined,
): ToolResult {
  if (!diagnostics || !result.ok) {
    return result;
  }

  const section = formatDiagnosticsResult(diagnostics);
  return {
    ...result,
    content: [result.content, "", section].join("\n"),
    metadata: {
      ...result.metadata,
      typescriptDiagnostics: {
        status: diagnostics.status,
        command: diagnostics.command,
        exitCode: diagnostics.exitCode,
        diagnostics: diagnostics.diagnostics,
        message: diagnostics.message,
      },
    },
  };
}

export function formatDiagnosticsResult(result: DiagnosticsResult): string {
  if (result.status === "ok") {
    return [
      "TypeScript diagnostics:",
      `Command: ${result.command}`,
      "No issues found.",
    ].join("\n");
  }

  if (result.status === "failed") {
    return [
      "TypeScript diagnostics failed:",
      `Command: ${result.command}`,
      result.message ?? "Diagnostics command failed without output.",
    ].join("\n");
  }

  return [
    "TypeScript diagnostics:",
    `Command: ${result.command}`,
    ...result.diagnostics.map(
      (diagnostic) =>
        `- ${diagnostic.file}:${diagnostic.line}:${diagnostic.character} ${diagnostic.code} ${diagnostic.severity}: ${diagnostic.message}`,
    ),
  ].join("\n");
}

async function isTypeScriptProject(cwd: string): Promise<boolean> {
  try {
    await access(resolve(cwd, "tsconfig.json"));
    return true;
  } catch {
    return false;
  }
}

function getToolInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

function isTypeScriptRelevantPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.endsWith(".ts") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".mts") ||
    normalized.endsWith(".cts") ||
    normalized.endsWith("/tsconfig.json") ||
    normalized === "tsconfig.json"
  );
}

function normalizeDiagnosticPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function getSpawnCommand(command: string, args: string[]): {
  command: string;
  args: string[];
} {
  if (process.platform !== "win32" || command.toLowerCase().endsWith(".exe")) {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/c", buildWindowsCommandLine(command, args)],
  };
}

function buildWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
