import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { sha256 } from "../utils/hash.js";
import {
  assertRealPathInsideCwd,
  PathOutsideWorkspaceError,
  resolveInsideCwd,
} from "../utils/paths.js";
import { fail, ok } from "./result.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";

const readFileInput = z.object({
  path: z.string().min(1).describe("Path to the file, relative to the workspace."),
  offset: z.number().int().nonnegative().optional().describe("Optional zero-based line offset."),
  limit: z.number().int().positive().optional().describe("Optional maximum number of lines to return."),
});

type ReadFileInput = z.infer<typeof readFileInput>;

export const readFileTool: Tool<ReadFileInput> = {
  name: "read_file",
  description:
    "Read a text file inside the current workspace. Supports optional zero-based line offset and line limit.",
  inputSchema: jsonSchema(readFileInput),
  inputValidator: readFileInput,
  safety: "read",
  readOnly: true,
  requiresApproval: false,
  async execute(input, ctx) {
    let absolutePath: string;
    try {
      absolutePath = resolveInsideCwd(ctx.cwd, input.path);
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
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return fail({
          code: "FileNotFound",
          message: `Not a file: ${input.path}`,
          content: `The path exists but is not a file: ${input.path}`,
          recoverable: true,
        });
      }

      const raw = await readFile(absolutePath, "utf8");
      const content = sliceLines(raw, input.offset, input.limit);
      const hash = sha256(raw);
      ctx.readTracker.recordRead({
        path: absolutePath,
        mtimeMs: fileStat.mtimeMs,
        hash,
      });

      const stored = await ctx.artifactStore.maybeStore("read_file", content);
      return ok(stored.content, {
        path: input.path,
        absolutePath,
        mtimeMs: fileStat.mtimeMs,
        hash,
        ...stored.metadata,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return fail({
          code: "FileNotFound",
          message: `File not found: ${input.path}`,
          content: `File not found: ${input.path}. Try list_files or grep_search to locate the correct path.`,
          recoverable: true,
        });
      }

      return fail({
        code: "UnknownError",
        message:
          error instanceof Error
            ? error.message
            : `Failed to read file: ${input.path}`,
        recoverable: true,
      });
    }
  },
};

function sliceLines(
  raw: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  if (offset === undefined && limit === undefined) {
    return raw;
  }

  const lines = raw.split(/\r?\n/);
  return lines
    .slice(offset ?? 0, limit ? (offset ?? 0) + limit : undefined)
    .join("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
