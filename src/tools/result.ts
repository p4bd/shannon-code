export type ToolResult =
  | {
      ok: true;
      content: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: ToolError;
      content: string;
      recoverable: boolean;
    };

export interface ToolError {
  code:
    | "FileNotFound"
    | "PermissionDenied"
    | "ReadBeforeEditRequired"
    | "FileModifiedSinceRead"
    | "SearchStringNotFound"
    | "SearchStringNotUnique"
    | "CommandFailed"
    | "CommandTimedOut"
    | "DangerousCommand"
    | "SchemaValidationFailed"
    | "TruncatedToolCall"
    | "NetworkError"
    | "McpError"
    | "HookDenied"
    | "UnknownError";
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export function ok(
  content: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return metadata ? { ok: true, content, metadata } : { ok: true, content };
}

export function fail(input: {
  code: ToolError["code"];
  message: string;
  content?: string;
  recoverable?: boolean;
  suggestion?: string;
  details?: Record<string, unknown>;
}): ToolResult {
  const details = withDerivedDetails(input.details);
  const suggestion =
    input.suggestion ??
    getDefaultRecoverySuggestion({
      code: input.code,
      details,
    });

  return {
    ok: false,
    error: {
      code: input.code,
      message: input.message,
      suggestion,
      details,
    },
    content: appendRecoverySuggestion(input.content ?? input.message, suggestion),
    recoverable: input.recoverable ?? true,
  };
}

export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}

function appendRecoverySuggestion(content: string, suggestion: string | undefined): string {
  if (!suggestion || content.includes("Suggested recovery:")) {
    return content;
  }

  return [content, "", `Suggested recovery: ${suggestion}`].join("\n");
}

function getDefaultRecoverySuggestion(input: {
  code: ToolError["code"];
  details?: Record<string, unknown>;
}): string | undefined {
  switch (input.code) {
    case "FileNotFound":
      return "Use list_files on the nearest known directory or grep_search for a distinctive filename or symbol, then retry with the exact workspace-relative path.";
    case "ReadBeforeEditRequired":
      return "Call read_file on the target path first, then retry edit_file with an exact substring from the current content.";
    case "FileModifiedSinceRead":
      return "Call read_file again to refresh the edit guard, then retry edit_file against the latest content.";
    case "SearchStringNotFound":
      return "Call read_file on the target path again and use an exact substring from the current file content before retrying edit_file.";
    case "SearchStringNotUnique":
      return "Use read_file to choose a longer unique oldString, or set replaceAll only when replacing every occurrence is intended.";
    case "CommandFailed":
      return "Inspect the exit code, STDOUT, and STDERR above, then adjust the command, path, dependency, or arguments before retrying.";
    case "CommandTimedOut":
      return "Narrow the command scope or retry with a larger timeoutMs value if the long-running command is expected.";
    case "SchemaValidationFailed":
      return `Fix the JSON input to match the tool schema.${formatSchemaSuggestion(
        input.details?.schemaSummary,
      )}`;
    case "TruncatedToolCall":
      return "Reissue the tool call with complete arguments.";
    case "DangerousCommand":
      return "Choose a safer read-only inspection command or explain the needed destructive action before attempting a different approach.";
    case "PermissionDenied":
      return "Use an allowed tool or adjust the request so it fits the current permission mode and project rules.";
    case "HookDenied":
      return "Respect the hook policy and choose a different tool input or workflow.";
    case "McpError":
      return "Check the MCP server response, tool arguments, and server availability before retrying.";
    case "NetworkError":
      return "Retry later or verify network configuration and the requested endpoint.";
    case "UnknownError":
      return "Use the error message and recent tool context to choose a smaller diagnostic step before retrying.";
  }
}

function withDerivedDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  if (!("schema" in details) || "schemaSummary" in details) {
    return details;
  }

  return {
    ...details,
    schemaSummary: summarizeJsonSchema(details.schema),
  };
}

function formatSchemaSuggestion(schemaSummary: unknown): string {
  return typeof schemaSummary === "string" && schemaSummary.length > 0
    ? ` Expected schema: ${schemaSummary}`
    : "";
}

function summarizeJsonSchema(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return JSON.stringify(schema);
  }

  const record = schema as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.type === "string") {
    parts.push(`type=${record.type}`);
  }
  if (Array.isArray(record.required) && record.required.length > 0) {
    parts.push(`required=${record.required.filter(isString).join(",")}`);
  }

  if (record.properties && typeof record.properties === "object") {
    const properties = Object.entries(record.properties as Record<string, unknown>)
      .map(([name, value]) => `${name}:${getSchemaType(value)}`)
      .join(",");
    if (properties.length > 0) {
      parts.push(`properties=${properties}`);
    }
  }

  const summary = parts.length > 0 ? parts.join("; ") : JSON.stringify(schema);
  return summary.length > 1_000 ? `${summary.slice(0, 997)}...` : summary;
}

function getSchemaType(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }

  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" ? type : "unknown";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
