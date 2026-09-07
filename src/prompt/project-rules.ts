import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readMarkdownWithIncludes } from "./includes.js";

export interface ProjectRuleSection {
  source: string;
  content: string;
}

export interface ProjectRules {
  sections: ProjectRuleSection[];
  content: string;
}

const ROOT_RULE_FILES = ["AGENTS.md", "CLAUDE.md"];

export async function loadProjectRules(cwd: string): Promise<ProjectRules> {
  const sources = [
    ...(await existingRootRuleFiles(cwd)),
    ...(await agentRuleFiles(cwd)),
  ];
  const sections: ProjectRuleSection[] = [];

  for (const source of sources) {
    try {
      const content = await readMarkdownWithIncludes({ cwd, sourcePath: source });
      sections.push({ source, content: content.trim() });
    } catch (error) {
      sections.push({
        source,
        content: `[Failed to load project rules from ${source}: ${
          error instanceof Error ? error.message : "unknown error"
        }]`,
      });
    }
  }

  return {
    sections,
    content: sections
      .filter((section) => section.content.length > 0)
      .map((section) => `## ${section.source}\n${section.content}`)
      .join("\n\n"),
  };
}

async function existingRootRuleFiles(cwd: string): Promise<string[]> {
  const results = await Promise.all(
    ROOT_RULE_FILES.map(async (source) => {
      try {
        const fileStat = await stat(resolve(cwd, source));
        return fileStat.isFile() ? source : undefined;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }

        throw error;
      }
    }),
  );

  return results.filter((source): source is string => Boolean(source));
}

async function agentRuleFiles(cwd: string): Promise<string[]> {
  const rulesDir = resolve(cwd, ".agent", "rules");
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => `.agent/rules/${entry}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
