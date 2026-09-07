import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelMessage, ModelToolCall } from "../core/model-provider.js";
import type { PermissionMode } from "../permissions/modes.js";

export interface EvalCase {
  name: string;
  prompt: string;
  mode: "mock" | "real";
  maxTurns: number;
  permissionMode: PermissionMode;
  workspace: EvalWorkspace;
  mock?: EvalMockConfig;
  initialMessages?: ModelMessage[];
  skillName?: string;
  skillArgs?: string;
  mcpTestServer?: boolean;
  assertions: EvalAssertion[];
}

export interface EvalWorkspace {
  files: Record<string, string | EvalGeneratedFile>;
}

export interface EvalGeneratedFile {
  repeat: string;
  count: number;
}

export interface EvalMockConfig {
  supportsPromptCaching: boolean;
  steps: EvalMockStep[];
}

export interface EvalMockStep {
  content?: string;
  toolCalls?: Array<Pick<ModelToolCall, "name" | "input">>;
}

export type EvalAssertion =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_not_contains"; path: string; text: string }
  | { type: "command_succeeds"; command: string }
  | { type: "stdout_contains"; command: string; text: string }
  | { type: "session_contains"; text: string }
  | { type: "tool_called"; name: string }
  | { type: "tool_not_called"; name: string };

export async function loadEvalCases(casesDir: string): Promise<EvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const caseFiles = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => resolve(casesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(caseFiles.map(loadEvalCase));
}

export async function loadEvalCase(path: string): Promise<EvalCase> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return normalizeEvalCase(parsed, path);
}

export function normalizeEvalCase(value: unknown, path = "<inline>"): EvalCase {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid eval case at ${path}: expected object.`);
  }

  const record = value as Record<string, unknown>;
  const name = requireString(record.name, path, "name");
  const prompt = requireString(record.prompt, path, "prompt");
  const mode = record.mode === "real" ? "real" : "mock";
  const mock = normalizeMock(record.mock, path, mode);

  return {
    name,
    prompt,
    mode,
    maxTurns: readPositiveInteger(record.maxTurns) ?? 8,
    permissionMode: normalizePermissionMode(record.permissionMode),
    workspace: normalizeWorkspace(record.workspace),
    mock,
    initialMessages: normalizeInitialMessages(record.initialMessages),
    skillName: readOptionalString(record.skillName),
    skillArgs: readOptionalString(record.skillArgs),
    mcpTestServer: record.mcpTestServer === true,
    assertions: normalizeAssertions(record.assertions ?? record.assert, path),
  };
}

export function expandGeneratedFile(value: string | EvalGeneratedFile): string {
  if (typeof value === "string") {
    return value;
  }

  return value.repeat.repeat(value.count);
}

function normalizeWorkspace(value: unknown): EvalWorkspace {
  if (!value || typeof value !== "object") {
    return { files: {} };
  }

  const files = (value as Record<string, unknown>).files;
  if (!files || typeof files !== "object") {
    return { files: {} };
  }

  return {
    files: Object.fromEntries(
      Object.entries(files as Record<string, unknown>).map(([path, content]) => [
        path,
        normalizeFileContent(content),
      ]),
    ),
  };
}

function normalizeFileContent(value: unknown): string | EvalGeneratedFile {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.repeat === "string") {
      return {
        repeat: record.repeat,
        count: readPositiveInteger(record.count) ?? 1,
      };
    }
  }

  return String(value ?? "");
}

function normalizeMock(
  value: unknown,
  path: string,
  mode: "mock" | "real",
): EvalMockConfig | undefined {
  if (mode === "real") {
    return undefined;
  }

  if (!value || typeof value !== "object") {
    throw new Error(`Invalid eval case at ${path}: mock.steps is required.`);
  }

  const record = value as Record<string, unknown>;
  const steps = record.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`Invalid eval case at ${path}: mock.steps must be a non-empty array.`);
  }

  return {
    supportsPromptCaching: record.supportsPromptCaching === true,
    steps: steps.map((step, index) => normalizeMockStep(step, path, index)),
  };
}

function normalizeMockStep(value: unknown, path: string, index: number): EvalMockStep {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid eval case at ${path}: mock.steps[${index}] must be an object.`);
  }

  const record = value as Record<string, unknown>;
  return {
    content: typeof record.content === "string" ? record.content : "",
    toolCalls: Array.isArray(record.toolCalls)
      ? record.toolCalls.map((toolCall, toolIndex) =>
          normalizeMockToolCall(toolCall, path, index, toolIndex),
        )
      : [],
  };
}

function normalizeMockToolCall(
  value: unknown,
  path: string,
  stepIndex: number,
  toolIndex: number,
): Pick<ModelToolCall, "name" | "input"> {
  if (!value || typeof value !== "object") {
    throw new Error(
      `Invalid eval case at ${path}: mock.steps[${stepIndex}].toolCalls[${toolIndex}] must be an object.`,
    );
  }

  const record = value as Record<string, unknown>;
  return {
    name: requireString(record.name, path, `mock.steps[${stepIndex}].toolCalls[${toolIndex}].name`),
    input: record.input ?? {},
  };
}

function normalizeInitialMessages(value: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((message): ModelMessage[] => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const record = message as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (
      (role === "system" || role === "user" || role === "assistant" || role === "tool") &&
      typeof content === "string"
    ) {
      return [{ role, content }];
    }
    return [];
  });
}

function normalizeAssertions(value: unknown, path: string): EvalAssertion[] {
  if (Array.isArray(value)) {
    return value.map((assertion, index) => normalizeAssertion(assertion, path, index));
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(
      ([type, assertion], index) =>
        normalizeAssertion({ ...(assertion as object), type }, path, index),
    );
  }

  throw new Error(`Invalid eval case at ${path}: assertions must be an array.`);
}

function normalizeAssertion(
  value: unknown,
  path: string,
  index: number,
): EvalAssertion {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid eval case at ${path}: assertion ${index} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const type = requireString(record.type, path, `assertions[${index}].type`);
  switch (type) {
    case "file_exists":
      return { type, path: requireString(record.path, path, "path") };
    case "file_contains":
    case "file_not_contains":
      return {
        type,
        path: requireString(record.path, path, "path"),
        text: requireString(record.text, path, "text"),
      };
    case "command_succeeds":
      return { type, command: requireString(record.command, path, "command") };
    case "stdout_contains":
      return {
        type,
        command: requireString(record.command, path, "command"),
        text: requireString(record.text, path, "text"),
      };
    case "session_contains":
      return { type, text: requireString(record.text, path, "text") };
    case "tool_called":
    case "tool_not_called":
      return { type, name: requireString(record.name, path, "name") };
    default:
      throw new Error(`Invalid eval case at ${path}: unsupported assertion "${type}".`);
  }
}

function normalizePermissionMode(value: unknown): PermissionMode {
  return value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "dontAsk"
    ? value
    : "default";
}

function requireString(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid eval case at ${path}: "${field}" must be a string.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

