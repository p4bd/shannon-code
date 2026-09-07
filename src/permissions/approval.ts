import type { ShellAnalysis } from "./shell-analyzer.js";

export interface ToolApprovalRequest {
  toolName: string;
  toolInput: unknown;
  subject: string;
  reason: string;
  cwd: string;
  shellAnalysis?: ShellAnalysis;
}

export type ToolApprovalPrompt = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

export function formatApprovalUnavailableMessage(toolName: string): string {
  return `Tool "${toolName}" needs approval, but interactive approval is not available in this run. Add an allow rule in .agent/settings.json, approve it in REPL, or use --yolo when you intentionally want to bypass permissions.`;
}
