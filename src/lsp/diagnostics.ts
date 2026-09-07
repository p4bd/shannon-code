import type { ToolResult } from "../tools/result.js";

export interface Diagnostic {
  file: string;
  line: number;
  character: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export type DiagnosticsStatus = "ok" | "diagnostics" | "failed";

export interface DiagnosticsResult {
  status: DiagnosticsStatus;
  command: string;
  exitCode?: number | string | null;
  diagnostics: Diagnostic[];
  message?: string;
  rawOutput?: string;
}

export interface DiagnosticsRunner {
  runAfterTool(input: {
    toolName: string;
    toolInput: unknown;
    toolResult: ToolResult;
    cwd: string;
  }): Promise<DiagnosticsResult | undefined>;
}

