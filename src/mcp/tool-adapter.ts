import type { JsonSchema } from "../core/model-provider.js";
import { fail, ok, type ToolResult } from "../tools/result.js";
import type { Tool } from "../tools/types.js";
import type { McpClient, McpToolDefinition } from "./client.js";

export function createMcpToolAdapter(input: {
  serverName: string;
  tool: McpToolDefinition;
  client: McpClient;
}): Tool<Record<string, unknown>> {
  return {
    name: toMcpToolName(input.serverName, input.tool.name),
    description:
      input.tool.description ??
      `MCP tool ${input.tool.name} from server ${input.serverName}.`,
    inputSchema: normalizeSchema(input.tool.inputSchema),
    safety: "execute",
    readOnly: false,
    requiresApproval: false,
    async execute(toolInput, ctx): Promise<ToolResult> {
      try {
        const result = await input.client.callTool(
          input.tool.name,
          toolInput,
          ctx.abortSignal,
        );
        return ok(formatMcpToolResult(result), {
          serverName: input.serverName,
          mcpToolName: input.tool.name,
        });
      } catch (error) {
        ctx.abortSignal?.throwIfAborted();
        return fail({
          code: "McpError",
          message:
            error instanceof Error
              ? error.message
              : `MCP tool failed: ${input.tool.name}`,
          recoverable: true,
        });
      }
    },
  };
}

export function toMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeName(serverName)}__${sanitizeName(toolName)}`;
}

function normalizeSchema(schema: Record<string, unknown> | undefined): JsonSchema {
  if (!schema || typeof schema.type !== "string") {
    return { type: "object", additionalProperties: true };
  }

  return schema as JsonSchema;
}

function formatMcpToolResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    return record.content.map(formatContentPart).join("\n");
  }

  return JSON.stringify(result, null, 2);
}

function formatContentPart(part: unknown): string {
  if (!part || typeof part !== "object") {
    return String(part ?? "");
  }

  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }

  return JSON.stringify(record);
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
