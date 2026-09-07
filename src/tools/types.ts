import type { z } from "zod";
import type { LargeResultStore } from "../context/large-result-store.js";
import type { ReadTracker } from "../context/read-tracker.js";
import type { JsonSchema } from "../core/model-provider.js";
import type { HookExecutor } from "../hooks/types.js";
import type { DiagnosticsRunner } from "../lsp/diagnostics.js";
import type { ToolApprovalPrompt } from "../permissions/approval.js";
import type { PermissionMode } from "../permissions/modes.js";
import type { Logger } from "../utils/logger.js";
import type { ToolResult } from "./result.js";

export type ToolSafety = "read" | "write" | "execute" | "network";

export interface ToolContext {
  cwd: string;
  sessionId: string;
  permissionMode: PermissionMode;
  subagentDepth: number;
  subagentRunner?: SubagentRunner;
  hookRunner?: HookExecutor;
  diagnosticsRunner?: DiagnosticsRunner;
  approvalPrompt?: ToolApprovalPrompt;
  abortSignal?: AbortSignal;
  readTracker: ReadTracker;
  artifactStore: LargeResultStore;
  logger: Logger;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  inputValidator?: z.ZodType<Input>;
  safety: ToolSafety;
  readOnly: boolean;
  concurrencySafe?: boolean;
  requiresApproval: boolean;
  enabledInPlanMode?: boolean;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

export interface SubagentRunner {
  run(input: SubagentRunInput): Promise<ToolResult>;
}

export interface SubagentRunInput {
  agentType: string;
  prompt: string;
  maxTurns?: number;
  parentSessionId: string;
  depth: number;
  signal?: AbortSignal;
}
