import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { PermissionMode } from "../permissions/modes.js";

export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools?: string[];
  permissionMode: PermissionMode;
  builtIn: boolean;
  path?: string;
}

export const BUILT_IN_SUBAGENTS: SubagentConfig[] = [
  {
    name: "explore",
    description: "Read-only code and file exploration.",
    systemPrompt:
      "You are an explore sub-agent. Inspect the workspace with read-only tools and return concise findings with file paths and evidence.",
    allowedTools: ["read_file", "list_files", "grep_search"],
    permissionMode: "plan",
    builtIn: true,
  },
  {
    name: "plan",
    description: "Read-only implementation planning.",
    systemPrompt:
      "You are a planning sub-agent. Use read-only tools to produce a practical implementation plan. Do not modify files.",
    allowedTools: ["read_file", "list_files", "grep_search"],
    permissionMode: "plan",
    builtIn: true,
  },
  {
    name: "general",
    description: "General sub-agent with normal tools except recursive agent delegation.",
    systemPrompt:
      "You are a general sub-agent. Complete the delegated task independently and return a concise summary.",
    allowedTools: [
      "read_file",
      "list_files",
      "grep_search",
      "run_shell",
      "write_file",
      "edit_file",
    ],
    permissionMode: "default",
    builtIn: true,
  },
];

export async function loadSubagentConfigs(cwd: string): Promise<SubagentConfig[]> {
  const custom = await loadCustomSubagents(cwd);
  const byName = new Map<string, SubagentConfig>();
  for (const agent of BUILT_IN_SUBAGENTS) {
    byName.set(agent.name, agent);
  }
  for (const agent of custom) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

export function parseSubagentConfig(input: {
  fallbackName: string;
  path: string;
  raw: string;
}): SubagentConfig {
  const parsed = parseFrontmatter(input.raw);
  const name = getString(parsed.data.name) ?? sanitizeName(input.fallbackName);
  const description =
    getString(parsed.data.description) ?? firstNonEmptyLine(parsed.body) ?? name;
  const allowedTools = getStringArray(parsed.data.allowed_tools);
  const permissionMode = parsePermissionMode(getString(parsed.data.permission_mode));

  return {
    name,
    description,
    systemPrompt: parsed.body.trim(),
    allowedTools,
    permissionMode,
    builtIn: false,
    path: input.path,
  };
}

async function loadCustomSubagents(cwd: string): Promise<SubagentConfig[]> {
  const agentsDir = resolve(cwd, ".agent", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const configs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .sort()
      .map(async (entry): Promise<SubagentConfig | undefined> => {
        const path = resolve(agentsDir, entry);
        const fileStat = await stat(path);
        if (!fileStat.isFile()) {
          return undefined;
        }

        return parseSubagentConfig({
          fallbackName: entry.replace(/\.md$/i, ""),
          path: `.agent/agents/${entry}`,
          raw: await readFile(path, "utf8"),
        });
      }),
  );

  return configs.filter((config): config is SubagentConfig => Boolean(config));
}

function parseFrontmatter(raw: string): {
  data: Record<string, string | string[]>;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { data: {}, body: raw };
  }

  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: raw };
  }

  return {
    data: parseSimpleYaml(raw.slice(3, end).trim()),
    body: raw.slice(end + "\n---".length).replace(/^\r?\n/, ""),
  };
}

function parseSimpleYaml(raw: string): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};
  let currentArrayKey: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    if (currentArrayKey && trimmed.startsWith("- ")) {
      const existing = data[currentArrayKey];
      data[currentArrayKey] = [
        ...(Array.isArray(existing) ? existing : []),
        unquote(trimmed.slice(2).trim()),
      ];
      continue;
    }

    currentArrayKey = undefined;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (value.length === 0) {
      data[key] = [];
      currentArrayKey = key;
    } else {
      data[key] = parseScalarOrArray(value);
    }
  }

  return data;
}

function parseScalarOrArray(value: string): string | string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner.length === 0
      ? []
      : inner.split(",").map((item) => unquote(item.trim()));
  }

  return unquote(value);
}

function getString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function getStringArray(
  value: string | string[] | undefined,
): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  return value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "dontAsk"
    ? value
    : "default";
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
