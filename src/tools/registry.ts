import type { ModelToolDefinition } from "../core/model-provider.js";
import { appendDiagnosticsToToolResult } from "../lsp/typescript-diagnostics.js";
import { checkToolPermission } from "../permissions/checker.js";
import { fail, type ToolResult } from "./result.js";
import type { Tool, ToolContext } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  filterByNames(toolNames: string[] | undefined): ToolRegistry {
    if (!toolNames || toolNames.length === 0) {
      return this;
    }

    const allowed = new Set(toolNames);
    const registry = new ToolRegistry();
    for (const tool of this.list()) {
      if (allowed.has(tool.name)) {
        registry.register(tool);
      }
    }

    return registry;
  }

  getModelToolDefinitions(toolNames?: string[]): ModelToolDefinition[] {
    return this.filterByNames(toolNames).list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      return fail({
        code: "UnknownError",
        message: `Unknown tool: ${name}`,
        content: `Tool "${name}" is not registered. Use available tools only.`,
        recoverable: true,
      });
    }

    const preHook = await ctx.hookRunner?.runPreToolUse({
      toolName: name,
      toolInput: input,
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
    });
    if (preHook && !preHook.allowed) {
      return fail({
        code: "HookDenied",
        message: `Tool "${name}" was denied by a PreToolUse hook.`,
        content: appendHookMessages(
          `Tool "${name}" was denied by a PreToolUse hook: ${
            preHook.reason ?? "No reason provided."
          }`,
          preHook.appendMessages,
        ),
        recoverable: true,
        details: { tool: name, reason: preHook.reason },
      });
    }

    const effectiveInput = preHook?.toolInput ?? input;
    const preHookMessages = preHook?.appendMessages ?? [];

    if (tool.inputValidator) {
      const parsed = tool.inputValidator.safeParse(effectiveInput);
      if (!parsed.success) {
        return fail({
          code: "SchemaValidationFailed",
          message: `Invalid input for tool "${name}".`,
          content: [
            `Invalid input for tool "${name}".`,
            "Validation issues:",
            ...parsed.error.issues.map(
              (issue) =>
                `- ${issue.path.join(".") || "(root)"}: ${issue.message}`,
            ),
          ].join("\n"),
          details: {
            issues: parsed.error.issues,
            schema: tool.inputSchema,
          },
          recoverable: true,
        });
      }

      return executePermittedTool({
        tool,
        toolInput: parsed.data,
        ctx,
        preHookMessages,
      });
    }

    return executePermittedTool({
      tool,
      toolInput: effectiveInput,
      ctx,
      preHookMessages,
    });
  }
}

async function executePermittedTool(input: {
  tool: Tool;
  toolInput: unknown;
  ctx: ToolContext;
  preHookMessages: string[];
}): Promise<ToolResult> {
  const permission = await checkToolPermission({
    tool: input.tool,
    toolInput: input.toolInput,
    ctx: input.ctx,
  });
  if (!permission.allowed) {
    return fail(permission);
  }

  if (permission.risk) {
    input.ctx.logger.warn(permission.risk, {
      tool: input.tool.name,
      permissionMode: input.ctx.permissionMode,
    });
  }

  const result = await input.tool.execute(input.toolInput, input.ctx);
  const diagnostics = await input.ctx.diagnosticsRunner?.runAfterTool({
    toolName: input.tool.name,
    toolInput: input.toolInput,
    toolResult: result,
    cwd: input.ctx.cwd,
  });
  const resultWithDiagnostics = appendDiagnosticsToToolResult(
    result,
    diagnostics,
  );
  const postHook = await input.ctx.hookRunner?.runPostToolUse({
    toolName: input.tool.name,
    toolInput: input.toolInput,
    toolResult: resultWithDiagnostics,
    cwd: input.ctx.cwd,
    sessionId: input.ctx.sessionId,
  });

  return appendHookMessagesToResult(resultWithDiagnostics, [
    ...input.preHookMessages,
    ...(postHook?.appendMessages ?? []),
  ]);
}

function appendHookMessagesToResult(
  result: ToolResult,
  messages: string[],
): ToolResult {
  if (messages.length === 0) {
    return result;
  }

  return {
    ...result,
    content: appendHookMessages(result.content, messages),
  };
}

function appendHookMessages(content: string, messages: string[]): string {
  const filtered = messages.map((message) => message.trim()).filter(Boolean);
  if (filtered.length === 0) {
    return content;
  }

  return [content, "", "Hook messages:", ...filtered].join("\n");
}
