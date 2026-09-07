import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface PermissionSettings {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export type PermissionRuleKind = "allow" | "deny";

export interface MatchedPermissionRule {
  kind: PermissionRuleKind;
  rule: string;
}

const EMPTY_SETTINGS: PermissionSettings = {
  permissions: {
    allow: [],
    deny: [],
  },
};

export async function loadPermissionSettings(
  cwd: string,
): Promise<PermissionSettings> {
  const settingsPath = resolve(cwd, ".agent", "settings.json");

  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return EMPTY_SETTINGS;
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as Partial<PermissionSettings>;
  return {
    permissions: {
      allow: parsed.permissions?.allow?.filter(isString) ?? [],
      deny: parsed.permissions?.deny?.filter(isString) ?? [],
    },
  };
}

export function findPermissionRule(input: {
  settings: PermissionSettings;
  kind: PermissionRuleKind;
  toolName: string;
  subject: string;
}): MatchedPermissionRule | undefined {
  const rules = input.settings.permissions[input.kind];
  const matched = rules.find((rule) =>
    matchesPermissionRule(rule, input.toolName, input.subject),
  );

  return matched ? { kind: input.kind, rule: matched } : undefined;
}

export function matchesPermissionRule(
  rule: string,
  toolName: string,
  subject: string,
): boolean {
  const separatorIndex = rule.indexOf(":");
  const ruleTool =
    separatorIndex === -1 ? rule.trim() : rule.slice(0, separatorIndex).trim();
  const ruleSubject =
    separatorIndex === -1 ? "*" : rule.slice(separatorIndex + 1).trim();

  return (
    wildcardMatches(ruleTool, toolName) &&
    wildcardMatches(normalizeRuleSubject(ruleSubject), normalizeRuleSubject(subject))
  );
}

export function getPermissionSubject(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "*";
  }

  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") {
    return normalizeCommand(record.command);
  }

  if (typeof record.path === "string") {
    return record.path.replaceAll("\\", "/");
  }

  return "*";
}

function wildcardMatches(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "i");
  return regex.test(value);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizeRuleSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, " ").replaceAll("\\", "/");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
