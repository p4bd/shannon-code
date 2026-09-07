import type { ToolError } from "../tools/result.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { formatApprovalUnavailableMessage } from "./approval.js";
import {
  findPermissionRule,
  getPermissionSubject,
  loadPermissionSettings,
  type PermissionSettings,
} from "./rules.js";
import { analyzeShellCommand, type ShellAnalysis } from "./shell-analyzer.js";

export type PermissionDecision =
  | {
      allowed: true;
      reason: string;
      matchedRule?: string;
      shellAnalysis?: ShellAnalysis;
      risk?: string;
    }
  | {
      allowed: false;
      code: ToolError["code"];
      message: string;
      content: string;
      recoverable: boolean;
      details?: Record<string, unknown>;
    };

export async function checkToolPermission(input: {
  tool: Tool;
  toolInput: unknown;
  ctx: ToolContext;
}): Promise<PermissionDecision> {
  const subject = getPermissionSubject(input.toolInput);
  let settings: PermissionSettings;
  try {
    settings = await loadPermissionSettings(input.ctx.cwd);
  } catch (error) {
    return {
      allowed: false,
      code: "PermissionDenied",
      message: "Failed to read .agent/settings.json.",
      content:
        error instanceof Error
          ? `Failed to read .agent/settings.json: ${error.message}`
          : "Failed to read .agent/settings.json.",
      recoverable: true,
    };
  }
  const denyRule = findPermissionRule({
    settings,
    kind: "deny",
    toolName: input.tool.name,
    subject,
  });

  if (denyRule) {
    return {
      allowed: false,
      code: "PermissionDenied",
      message: `Permission denied by rule: ${denyRule.rule}`,
      content: `Permission denied by .agent/settings.json rule: ${denyRule.rule}`,
      recoverable: true,
      details: { rule: denyRule.rule },
    };
  }

  if (
    input.ctx.permissionMode === "plan" &&
    (input.tool.enabledInPlanMode === false || !input.tool.readOnly)
  ) {
    if (input.tool.name === "write_file" && isPlanFileSubject(subject)) {
      return {
        allowed: true,
        reason: "plan mode allows writing plan files",
      };
    }

    return {
      allowed: false,
      code: "PermissionDenied",
      message: `Tool "${input.tool.name}" is not enabled in plan mode.`,
      content: `Plan mode can only use read-only planning-safe tools. "${input.tool.name}" was blocked.`,
      recoverable: true,
    };
  }

  const shellAnalysis =
    input.tool.name === "run_shell" && typeof subject === "string"
      ? analyzeShellCommand(subject)
      : undefined;

  if (input.ctx.permissionMode === "bypassPermissions") {
    return {
      allowed: true,
      reason: "bypassPermissions mode",
      shellAnalysis,
      risk:
        shellAnalysis?.status === "dangerous"
          ? `Dangerous shell command allowed by bypassPermissions: ${shellAnalysis.reasons.join(", ")}`
          : undefined,
    };
  }

  const allowRule = findPermissionRule({
    settings,
    kind: "allow",
    toolName: input.tool.name,
    subject,
  });

  if (allowRule) {
    return {
      allowed: true,
      reason: `allowed by rule: ${allowRule.rule}`,
      matchedRule: allowRule.rule,
      shellAnalysis,
      risk:
        shellAnalysis?.status === "dangerous"
          ? `Dangerous shell command allowed by explicit allow rule: ${allowRule.rule}`
          : undefined,
    };
  }

  if (input.tool.readOnly) {
    return { allowed: true, reason: "read-only tool" };
  }

  if (input.ctx.permissionMode === "dontAsk" && input.tool.requiresApproval) {
    return {
      allowed: false,
      code: "PermissionDenied",
      message: `Tool "${input.tool.name}" requires approval, but permission mode is dontAsk.`,
      content: `The tool "${input.tool.name}" requires approval and cannot run in dontAsk mode.`,
      recoverable: true,
    };
  }

  if (input.tool.name === "run_shell" && shellAnalysis) {
    if (shellAnalysis.status === "safe") {
      return {
        allowed: true,
        reason: "safe shell command",
        shellAnalysis,
      };
    }

    if (shellAnalysis.status === "dangerous") {
      return {
        allowed: false,
        code: "DangerousCommand",
        message: `Dangerous shell command blocked: ${subject}`,
        content: [
          `Dangerous shell command blocked: ${subject}`,
          `Reasons: ${shellAnalysis.reasons.join(", ")}`,
        ].join("\n"),
        recoverable: true,
        details: {
          command: subject,
          shellSafety: shellAnalysis.status,
          reasons: shellAnalysis.reasons,
        },
      };
    }

    return requestApproval({
      tool: input.tool,
      toolInput: input.toolInput,
      ctx: input.ctx,
      subject,
      reason: `Shell command needs approval: ${shellAnalysis.reasons.join(", ")}`,
      shellAnalysis,
    });
  }

  if (input.ctx.permissionMode === "acceptEdits" && input.tool.safety === "write") {
    return {
      allowed: true,
      reason: "acceptEdits mode allows file writes",
    };
  }

  if (input.tool.requiresApproval) {
    return requestApproval({
      tool: input.tool,
      toolInput: input.toolInput,
      ctx: input.ctx,
      subject,
      reason: "Tool requires approval.",
    });
  }

  return {
    allowed: true,
    reason: "tool does not require approval",
  };
}

async function requestApproval(input: {
  tool: Tool;
  toolInput: unknown;
  ctx: ToolContext;
  subject: string;
  reason: string;
  shellAnalysis?: ShellAnalysis;
}): Promise<PermissionDecision> {
  if (!input.ctx.approvalPrompt) {
    return {
      allowed: false,
      code: "PermissionDenied",
      message: formatApprovalUnavailableMessage(input.tool.name),
      content: formatApprovalUnavailableMessage(input.tool.name),
      recoverable: true,
      details: {
        tool: input.tool.name,
        subject: input.subject,
      },
    };
  }

  const approved = await input.ctx.approvalPrompt({
    toolName: input.tool.name,
    toolInput: input.toolInput,
    subject: input.subject,
    reason: input.reason,
    cwd: input.ctx.cwd,
    shellAnalysis: input.shellAnalysis,
  });

  if (approved) {
    return {
      allowed: true,
      reason: `approved by user: ${input.tool.name}:${input.subject}`,
      shellAnalysis: input.shellAnalysis,
    };
  }

  return {
    allowed: false,
    code: "PermissionDenied",
    message: `Tool "${input.tool.name}" was denied by the user.`,
    content: `Tool "${input.tool.name}" was denied by the user. Choose a different approach or ask the user before retrying.`,
    recoverable: true,
    details: {
      tool: input.tool.name,
      subject: input.subject,
    },
  };
}

function isPlanFileSubject(subject: string): boolean {
  const normalized = subject.replaceAll("\\", "/");
  return /^\.agent\/plans\/[^/]+\.md$/i.test(normalized);
}
