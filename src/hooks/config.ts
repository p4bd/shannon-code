import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { HookConfig } from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

const hookEventSchema = z.enum(["PreToolUse", "PostToolUse", "OnAgentFinish"]);

const hookEntrySchema = z.object({
  event: hookEventSchema,
  matcher: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const hookConfigSchema = z.union([
  z.object({ hooks: z.array(hookEntrySchema).optional() }),
  z.array(hookEntrySchema),
]);

export async function loadHookConfig(cwd: string): Promise<HookConfig> {
  const configPath = resolve(cwd, ".agent", "hooks.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { hooks: [] };
    }

    throw error;
  }

  return parseHookConfig(JSON.parse(raw));
}

export function parseHookConfig(value: unknown): HookConfig {
  const parsed = hookConfigSchema.parse(value);
  const hooks = Array.isArray(parsed) ? parsed : parsed.hooks ?? [];

  return {
    hooks: hooks.map((hook) => ({
      event: hook.event,
      matcher: hook.matcher ?? hook.toolName ?? "*",
      command: hook.command,
      args: hook.args ?? [],
      timeoutMs: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    })),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

