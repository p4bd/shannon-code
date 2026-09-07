import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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

const DEFAULT_RECURSIVE_EXCLUDE_DIRS = new Set(["node_modules", ".git"]);

const listFilesInput = z.object({
  path: z.string().min(1).optional().describe("Directory path relative to the workspace. Defaults to '.'."),
  recursive: z.boolean().optional().describe("Whether to recursively list descendants."),
  includeHidden: z.boolean().optional().describe("Whether to include dotfiles and hidden-style entries."),
  limit: z.number().int().positive().max(1000).optional().describe("Maximum number of entries to return, up to 1000."),
});

type ListFilesInput = z.infer<typeof listFilesInput>;

export const listFilesTool: Tool<ListFilesInput> = {
  name: "list_files",
  description:
    "List files and directories inside the current workspace. Use recursive only when needed.",
  inputSchema: jsonSchema(listFilesInput),
  inputValidator: listFilesInput,
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
      const rootStat = await stat(absolutePath);
      if (!rootStat.isDirectory()) {
        return fail({
          code: "FileNotFound",
          message: `Not a directory: ${requestedPath}`,
          recoverable: true,
        });
      }

      const entries = await collectEntries({
        cwd: ctx.cwd,
        root: absolutePath,
        recursive: input.recursive ?? false,
        includeHidden: input.includeHidden ?? false,
        limit: input.limit ?? 200,
      });

      return ok(entries.join("\n") || "(empty directory)", {
        path: requestedPath,
        count: entries.length,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return fail({
          code: "FileNotFound",
          message: `Directory not found: ${requestedPath}`,
          recoverable: true,
        });
      }

      return fail({
        code: "UnknownError",
        message:
          error instanceof Error
            ? error.message
            : `Failed to list files: ${requestedPath}`,
        recoverable: true,
      });
    }
  },
};

async function collectEntries(input: {
  cwd: string;
  root: string;
  recursive: boolean;
  includeHidden: boolean;
  limit: number;
}): Promise<string[]> {
  const output: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (output.length >= input.limit) {
      return;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (output.length >= input.limit) {
        return;
      }

      if (!input.includeHidden && entry.name.startsWith(".")) {
        continue;
      }

      if (
        input.recursive &&
        entry.isDirectory() &&
        DEFAULT_RECURSIVE_EXCLUDE_DIRS.has(entry.name)
      ) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      const workspacePath = toWorkspacePath(input.cwd, absolutePath);
      output.push(entry.isDirectory() ? `${workspacePath}/` : workspacePath);

      if (input.recursive && entry.isDirectory()) {
        await visit(absolutePath);
      }
    }
  }

  await visit(input.root);
  return output;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
