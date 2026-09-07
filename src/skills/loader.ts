import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Skill, SkillMode } from "./types.js";

interface ParsedFrontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const skillsRoot = resolve(cwd, ".agent", "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const skills = await Promise.all(
    entries.sort().map(async (entry): Promise<Skill | undefined> => {
      const skillDir = resolve(skillsRoot, entry);
      const skillPath = resolve(skillDir, "SKILL.md");
      try {
        const fileStat = await stat(skillPath);
        if (!fileStat.isFile()) {
          return undefined;
        }

        return parseSkill({
          fallbackName: entry,
          path: `.agent/skills/${entry}/SKILL.md`,
          raw: await readFile(skillPath, "utf8"),
        });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }

        throw error;
      }
    }),
  );

  return skills.filter((skill): skill is Skill => Boolean(skill));
}

export function parseSkill(input: {
  fallbackName: string;
  path: string;
  raw: string;
}): Skill {
  const parsed = parseFrontmatter(input.raw);
  const name = getString(parsed.data.name) ?? sanitizeName(input.fallbackName);
  const mode = parseMode(getString(parsed.data.mode));
  const description =
    getString(parsed.data.description) ?? firstNonEmptyLine(parsed.body) ?? name;
  const allowedTools = getStringArray(parsed.data.allowed_tools);

  return {
    name,
    description,
    allowedTools,
    mode,
    path: input.path,
    content: parsed.body.trim(),
  };
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---")) {
    return { data: {}, body: raw };
  }

  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: raw };
  }

  const frontmatter = raw.slice(3, end).trim();
  const body = raw.slice(end + "\n---".length).replace(/^\r?\n/, "");
  return {
    data: parseSimpleYaml(frontmatter),
    body,
  };
}

function parseSimpleYaml(raw: string): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};
  const lines = raw.split(/\r?\n/);
  let currentArrayKey: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    if (currentArrayKey && trimmed.startsWith("- ")) {
      const existing = data[currentArrayKey];
      const values = Array.isArray(existing) ? existing : [];
      values.push(unquote(trimmed.slice(2).trim()));
      data[currentArrayKey] = values;
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
      continue;
    }

    data[key] = parseScalarOrArray(value);
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

function parseMode(value: string | undefined): SkillMode {
  return value === "fork" ? "fork" : "inline";
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
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function sanitizeName(value: string): string {
  return basename(value).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
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
