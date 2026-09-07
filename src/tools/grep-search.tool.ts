import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  assertRealPathInsideCwd,
  PathOutsideWorkspaceError,
  resolveInsideCwd,
  toWorkspacePath,
} from "../utils/paths.js";
import { fail, ok } from "./result.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_MATCHES = 200;
const DEFAULT_EXCLUDE_GLOBS = ["!node_modules/**", "!.git/**"];

const grepSearchInput = z.object({
  pattern: z.string().min(1).describe("Search pattern, interpreted as a regular expression."),
  path: z.string().min(1).optional().describe("Optional file or directory path relative to the workspace. Defaults to '.'."),
  include: z.string().min(1).optional().describe("Optional glob-like include filter such as '*.ts'."),
});

type GrepSearchInput = z.infer<typeof grepSearchInput>;

export const grepSearchTool: Tool<GrepSearchInput> = {
  name: "grep_search",
  description:
    "Search text files in the workspace for a pattern. Uses ripgrep when available and falls back to a JavaScript scanner.",
  inputSchema: jsonSchema(grepSearchInput),
  inputValidator: grepSearchInput,
  safety: "read",
  readOnly: true,
  requiresApproval: false,
  async execute(input, ctx) {
    const requestedPath = input.path ?? ".";
    let absolutePath: string;
    try {
      absolutePath = resolveInsideCwd(ctx.cwd, requestedPath);
      await assertRealPathInsideCwd(ctx.cwd, absolutePath);
    } catch (error) {
      if (error instanceof PathOutsideWorkspaceError) {
        return fail({
          code: "PermissionDenied",
          message: error.message,
          recoverable: true,
        });
      }
      throw error;
    }

    try {
      const rgResult = await tryRipgrep({
        cwd: ctx.cwd,
        pattern: input.pattern,
        path: requestedPath,
        include: input.include,
      });
      if (rgResult !== undefined) {
        return ok(limitLines(rgResult) || "No matches found.", {
          engine: "rg",
          truncated: rgResult.split(/\r?\n/).length > MAX_MATCHES,
        });
      }

      const fallbackResult = await searchWithJavaScript({
        cwd: ctx.cwd,
        absolutePath,
        pattern: input.pattern,
        include: input.include,
      });
      return ok(fallbackResult.join("\n") || "No matches found.", {
        engine: "javascript",
        truncated: fallbackResult.length >= MAX_MATCHES,
      });
    } catch (error) {
      return fail({
        code: "UnknownError",
        message:
          error instanceof Error
            ? error.message
            : `Failed to search for pattern: ${input.pattern}`,
        recoverable: true,
      });
    }
  },
};

async function tryRipgrep(input: {
  cwd: string;
  pattern: string;
  path: string;
  include?: string;
}): Promise<string | undefined> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
  ];
  for (const glob of DEFAULT_EXCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  if (input.include) {
    args.push("--glob", input.include);
  }
  args.push(input.pattern, input.path);

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: input.cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const execError = error as Partial<{
      code: string | number;
      stdout: string;
    }>;
    if (execError.code === 1) {
      return execError.stdout ?? "";
    }
    if (execError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function searchWithJavaScript(input: {
  cwd: string;
  absolutePath: string;
  pattern: string;
  include?: string;
}): Promise<string[]> {
  const regex = new RegExp(input.pattern);
  const output: string[] = [];

  async function visit(absolutePath: string): Promise<void> {
    if (output.length >= MAX_MATCHES) {
      return;
    }

    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        await visit(join(absolutePath, entry.name));
      }
      return;
    }

    if (!fileStat.isFile()) {
      return;
    }

    const workspacePath = toWorkspacePath(input.cwd, absolutePath);
    if (input.include && !matchesInclude(workspacePath, input.include)) {
      return;
    }

    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (output.length >= MAX_MATCHES) {
        return;
      }
      if (regex.test(lines[index] ?? "")) {
        output.push(`${workspacePath}:${index + 1}:${lines[index]}`);
      }
    }
  }

  await visit(input.absolutePath);
  return output;
}

function limitLines(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, MAX_MATCHES)
    .map((line) => line.replaceAll("\\", "/").replace(/^\.\//, ""))
    .join("\n");
}

function matchesInclude(path: string, include: string): boolean {
  if (include.startsWith("*.")) {
    return path.endsWith(include.slice(1));
  }

  if (include.includes("*")) {
    const escaped = include.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replaceAll("*", ".*")}$`).test(path);
  }

  return path.includes(include);
}
