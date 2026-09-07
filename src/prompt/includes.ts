import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertRealPathInsideCwd,
  PathOutsideWorkspaceError,
  resolveInsideCwd,
  toWorkspacePath,
} from "../utils/paths.js";

export interface ResolveIncludesOptions {
  cwd: string;
  sourcePath: string;
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const INCLUDE_LINE_PATTERN = /^(\s*)@([^\s]+)\s*$/gm;

export async function readMarkdownWithIncludes(
  options: ResolveIncludesOptions,
): Promise<string> {
  const absolutePath = resolveInsideCwd(options.cwd, options.sourcePath);
  await assertRealPathInsideCwd(options.cwd, absolutePath);
  const visited = new Set<string>();
  return expandFile({
    cwd: options.cwd,
    absolutePath,
    depth: 0,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    visited,
  });
}

async function expandFile(input: {
  cwd: string;
  absolutePath: string;
  depth: number;
  maxDepth: number;
  visited: Set<string>;
}): Promise<string> {
  if (input.depth > input.maxDepth) {
    return `[Include skipped: max depth exceeded for ${toWorkspacePath(input.cwd, input.absolutePath)}]`;
  }

  if (input.visited.has(input.absolutePath)) {
    return `[Include skipped: cycle detected for ${toWorkspacePath(input.cwd, input.absolutePath)}]`;
  }

  input.visited.add(input.absolutePath);
  const raw = await readFile(input.absolutePath, "utf8");
  const baseDir = dirname(toWorkspacePath(input.cwd, input.absolutePath));

  const chunks: string[] = [];
  let lastIndex = 0;
  for (const match of raw.matchAll(INCLUDE_LINE_PATTERN)) {
    chunks.push(raw.slice(lastIndex, match.index));
    const indent = match[1] ?? "";
    const includePath = normalizeIncludePath(baseDir, match[2] ?? "");
    chunks.push(
      await expandInclude({
        cwd: input.cwd,
        includePath,
        indent,
        depth: input.depth + 1,
        maxDepth: input.maxDepth,
        visited: input.visited,
      }),
    );
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  chunks.push(raw.slice(lastIndex));
  input.visited.delete(input.absolutePath);
  return chunks.join("");
}

async function expandInclude(input: {
  cwd: string;
  includePath: string;
  indent: string;
  depth: number;
  maxDepth: number;
  visited: Set<string>;
}): Promise<string> {
  try {
    const absolutePath = resolveInsideCwd(input.cwd, input.includePath);
    await assertRealPathInsideCwd(input.cwd, absolutePath);
    const content = await expandFile({
      cwd: input.cwd,
      absolutePath,
      depth: input.depth,
      maxDepth: input.maxDepth,
      visited: input.visited,
    });
    return [
      `${input.indent}[Included from ${input.includePath}]`,
      content,
      `${input.indent}[/Included from ${input.includePath}]`,
    ].join("\n");
  } catch (error) {
    if (
      error instanceof PathOutsideWorkspaceError ||
      (error instanceof Error && "code" in error)
    ) {
      return `${input.indent}[Include failed for ${input.includePath}: ${
        error instanceof Error ? error.message : "unknown error"
      }]`;
    }

    throw error;
  }
}

function normalizeIncludePath(baseDir: string, includePath: string): string {
  const normalized = includePath.replaceAll("\\", "/");
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return baseDir === "." ? normalized : `${baseDir}/${normalized}`;
  }

  return normalized;
}
