import { spawn } from "node:child_process";
import { matchesHook } from "./matcher.js";
import type {
  AgentFinishHookResult,
  HookConfig,
  HookConfigEntry,
  HookEvent,
  HookExecutor,
  HookInput,
  HookOutput,
  PostToolUseHookResult,
  PreToolUseHookResult,
} from "./types.js";
import type { Logger } from "../utils/logger.js";
import { NoopLogger } from "../utils/logger.js";

export class HookRunner implements HookExecutor {
  private readonly logger: Logger;

  constructor(
    private readonly config: HookConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? new NoopLogger();
  }

  async runPreToolUse(input: {
    toolName: string;
    toolInput: unknown;
    cwd: string;
    sessionId: string;
  }): Promise<PreToolUseHookResult> {
    let currentInput = input.toolInput;
    const appendMessages: string[] = [];

    for (const output of await this.runMatchingHooks({
      event: "PreToolUse",
      toolName: input.toolName,
      toolInput: currentInput,
      cwd: input.cwd,
      sessionId: input.sessionId,
    })) {
      if (output.action === "deny") {
        return {
          allowed: false,
          toolInput: currentInput,
          reason: output.reason,
          appendMessages,
        };
      }

      if (output.action === "modify") {
        currentInput = output.toolInput;
      }

      if (output.action === "append") {
        appendMessages.push(output.message);
      }
    }

    return {
      allowed: true,
      toolInput: currentInput,
      appendMessages,
    };
  }

  async runPostToolUse(input: {
    toolName: string;
    toolInput: unknown;
    toolResult: HookInput["toolResult"];
    cwd: string;
    sessionId: string;
  }): Promise<PostToolUseHookResult> {
    const appendMessages: string[] = [];

    for (const output of await this.runMatchingHooks({
      event: "PostToolUse",
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolResult: input.toolResult,
      cwd: input.cwd,
      sessionId: input.sessionId,
    })) {
      if (output.action === "append") {
        appendMessages.push(output.message);
      }
    }

    return { appendMessages };
  }

  async runOnAgentFinish(input: {
    cwd: string;
    sessionId: string;
  }): Promise<AgentFinishHookResult> {
    const appendMessages: string[] = [];

    for (const output of await this.runMatchingHooks({
      event: "OnAgentFinish",
      cwd: input.cwd,
      sessionId: input.sessionId,
    })) {
      if (output.action === "append") {
        appendMessages.push(output.message);
      }
    }

    return { appendMessages };
  }

  private async runMatchingHooks(input: HookInput): Promise<HookOutput[]> {
    const outputs: HookOutput[] = [];
    for (const hook of this.getMatchingHooks(input.event, input.toolName)) {
      const output = await runHookCommand({
        hook,
        input,
        logger: this.logger,
      });
      if (output) {
        outputs.push(output);
      }
    }

    return outputs;
  }

  private getMatchingHooks(event: HookEvent, toolName: string | undefined): HookConfigEntry[] {
    return this.config.hooks.filter((hook) =>
      matchesHook({
        hook,
        event,
        toolName,
      }),
    );
  }
}

export async function runHookCommand(input: {
  hook: HookConfigEntry;
  input: HookInput;
  logger?: Logger;
}): Promise<HookOutput | undefined> {
  const logger = input.logger ?? new NoopLogger();

  return new Promise((resolve) => {
    const child = spawn(input.hook.command, input.hook.args, {
      cwd: input.input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (output: HookOutput | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(output);
    };

    const timeout = setTimeout(() => {
      logger.warn("Hook command timed out.", {
        event: input.input.event,
        toolName: input.input.toolName,
        command: input.hook.command,
        timeoutMs: input.hook.timeoutMs,
      });
      child.kill();
      finish(undefined);
    }, input.hook.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      logger.warn("Hook command failed to start.", {
        event: input.input.event,
        toolName: input.input.toolName,
        command: input.hook.command,
        error: error.message,
      });
      finish(undefined);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      if (code !== 0) {
        logger.warn("Hook command exited with a non-zero code.", {
          event: input.input.event,
          toolName: input.input.toolName,
          command: input.hook.command,
          code,
          stderr: stderr.trimEnd(),
        });
        finish(undefined);
        return;
      }

      try {
        finish(parseHookOutput(stdout));
      } catch (error) {
        logger.warn("Hook command returned invalid JSON output.", {
          event: input.input.event,
          toolName: input.input.toolName,
          command: input.hook.command,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(undefined);
      }
    });

    child.stdin.end(JSON.stringify(input.input));
  });
}

export function parseHookOutput(raw: string): HookOutput {
  const parsed = JSON.parse(raw.trim().length > 0 ? raw : "{}") as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Hook output must be an object.");
  }

  const record = parsed as Record<string, unknown>;
  switch (record.action) {
    case "allow":
      return { action: "allow" };
    case "deny":
      if (typeof record.reason !== "string") {
        throw new Error('Hook deny output requires a string "reason".');
      }
      return { action: "deny", reason: record.reason };
    case "modify":
      if (!("toolInput" in record)) {
        throw new Error('Hook modify output requires "toolInput".');
      }
      return { action: "modify", toolInput: record.toolInput };
    case "append":
      if (typeof record.message !== "string") {
        throw new Error('Hook append output requires a string "message".');
      }
      return { action: "append", message: record.message };
    default:
      throw new Error('Hook output action must be "allow", "deny", "modify", or "append".');
  }
}

