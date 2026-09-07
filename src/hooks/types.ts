import type { ToolResult } from "../tools/result.js";

export type HookEvent = "PreToolUse" | "PostToolUse" | "OnAgentFinish";

export interface HookConfigEntry {
  event: HookEvent;
  matcher: string;
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface HookConfig {
  hooks: HookConfigEntry[];
}

export interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  cwd: string;
  sessionId: string;
}

export type HookOutput =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; toolInput: unknown }
  | { action: "append"; message: string };

export interface PreToolUseHookResult {
  allowed: boolean;
  toolInput: unknown;
  reason?: string;
  appendMessages: string[];
}

export interface PostToolUseHookResult {
  appendMessages: string[];
}

export interface AgentFinishHookResult {
  appendMessages: string[];
}

export interface HookExecutor {
  runPreToolUse(input: {
    toolName: string;
    toolInput: unknown;
    cwd: string;
    sessionId: string;
  }): Promise<PreToolUseHookResult>;

  runPostToolUse(input: {
    toolName: string;
    toolInput: unknown;
    toolResult: ToolResult;
    cwd: string;
    sessionId: string;
  }): Promise<PostToolUseHookResult>;

  runOnAgentFinish(input: {
    cwd: string;
    sessionId: string;
  }): Promise<AgentFinishHookResult>;
}

