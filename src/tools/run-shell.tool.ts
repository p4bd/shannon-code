import { exec } from "node:child_process";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { fail, ok } from "./result.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const runShellInput = z.object({
  command: z.string().min(1).describe("Command to execute in the workspace shell."),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe(`Optional timeout in milliseconds, max ${MAX_TIMEOUT_MS}.`),
});

type RunShellInput = z.infer<typeof runShellInput>;

export const runShellTool: Tool<RunShellInput> = {
  name: "run_shell",
  description:
    "Run a shell command in the current workspace and return stdout, stderr, and exit status.",
  inputSchema: jsonSchema(runShellInput),
  inputValidator: runShellInput,
  safety: "execute",
  readOnly: false,
  requiresApproval: true,
  async execute(input, ctx) {
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const { stdout, stderr } = await execShell(input.command, {
        cwd: ctx.cwd,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        signal: ctx.abortSignal,
      });
      const stored = await ctx.artifactStore.maybeStore(
        "run_shell",
        formatShellOutput({ exitCode: 0, stdout, stderr }),
      );

      return ok(stored.content, {
        command: input.command,
        exitCode: 0,
        ...stored.metadata,
      });
    } catch (error) {
      ctx.abortSignal?.throwIfAborted();
      const shellError = error as Partial<{
        code: number | string;
        signal: NodeJS.Signals;
        stdout: Buffer;
        stderr: Buffer;
        killed: boolean;
      }>;

      if (shellError.killed || shellError.signal === "SIGTERM") {
        const stored = await ctx.artifactStore.maybeStore(
          "run_shell",
          formatShellOutput({
            exitCode: shellError.code,
            stdout: decodeShellBuffer(shellError.stdout),
            stderr: decodeShellBuffer(shellError.stderr),
          }),
        );
        return fail({
          code: "CommandTimedOut",
          message: `Command timed out after ${timeout}ms: ${input.command}`,
          content: stored.content,
          details: {
            command: input.command,
            timeoutMs: timeout,
            ...stored.metadata,
          },
          recoverable: true,
        });
      }

      const stored = await ctx.artifactStore.maybeStore(
        "run_shell",
        formatShellOutput({
          exitCode: shellError.code ?? 1,
          stdout: decodeShellBuffer(shellError.stdout),
          stderr: decodeShellBuffer(shellError.stderr),
        }),
      );
      return fail({
        code: "CommandFailed",
        message: `Command failed: ${input.command}`,
        content: stored.content,
        details: {
          command: input.command,
          exitCode: shellError.code ?? 1,
          ...stored.metadata,
        },
        recoverable: true,
      });
    }
  },
};

function execShell(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        ...options,
        encoding: "buffer",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const decoded = {
          stdout: decodeShellBuffer(stdout),
          stderr: decodeShellBuffer(stderr),
        };

        if (error) {
          Object.assign(error, {
            stdout,
            stderr,
          });
          reject(error);
          return;
        }

        resolve(decoded);
      },
    );
  });
}

function decodeShellBuffer(buffer: Buffer | undefined): string {
  if (!buffer || buffer.length === 0) {
    return "";
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    if (process.platform === "win32") {
      return new TextDecoder("gb18030").decode(buffer);
    }

    return new TextDecoder("utf-8").decode(buffer);
  }
}

function formatShellOutput(input: {
  exitCode: number | string | undefined;
  stdout: string;
  stderr: string;
}): string {
  return [
    `Exit code: ${input.exitCode ?? "unknown"}`,
    "STDOUT:",
    input.stdout.trimEnd() || "(empty)",
    "STDERR:",
    input.stderr.trimEnd() || "(empty)",
  ].join("\n");
}
