import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { createUnifiedDiff } from "../utils/diff.js";
import { sha256 } from "../utils/hash.js";
import {
  assertRealPathInsideCwd,
  PathOutsideWorkspaceError,
  resolveInsideCwd,
} from "../utils/paths.js";
import { fail, ok } from "./result.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";

const writeFileInput = z.object({
  path: z.string().min(1).describe("File path relative to the workspace."),
  content: z.string().describe("Complete file content to write."),
});

type WriteFileInput = z.infer<typeof writeFileInput>;

export const writeFileTool: Tool<WriteFileInput> = {
  name: "write_file",
  description:
    "Create or overwrite a text file inside the workspace. Parent directories are created automatically.",
  inputSchema: jsonSchema(writeFileInput),
  inputValidator: writeFileInput,
  safety: "write",
  readOnly: false,
  requiresApproval: true,
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
      const existing = await readExistingFile(absolutePath);
      if (existing.kind === "directory") {
        return fail({
          code: "FileNotFound",
          message: `Cannot write file because path is a directory: ${input.path}`,
          recoverable: true,
        });
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, input.content, "utf8");

      const fileStat = await stat(absolutePath);
      ctx.readTracker.recordRead({
        path: absolutePath,
        mtimeMs: fileStat.mtimeMs,
        hash: sha256(input.content),
      });

      const diff = createUnifiedDiff({
        path: input.path,
        oldContent: existing.content,
        newContent: input.content,
      });
      const stored = await ctx.artifactStore.maybeStore("write_file", diff);

      return ok(stored.content, {
        path: input.path,
        absolutePath,
        created: existing.kind === "missing",
        mtimeMs: fileStat.mtimeMs,
        ...stored.metadata,
      });
    } catch (error) {
      return fail({
        code: "UnknownError",
        message:
          error instanceof Error
            ? error.message
            : `Failed to write file: ${input.path}`,
        recoverable: true,
      });
    }
  },
};

type ExistingFile =
  | { kind: "file"; content: string }
  | { kind: "missing"; content: "" }
  | { kind: "directory"; content: "" };

async function readExistingFile(path: string): Promise<ExistingFile> {
  try {
    const fileStat = await stat(path);
    if (fileStat.isDirectory()) {
      return { kind: "directory", content: "" };
    }

    return { kind: "file", content: await readFile(path, "utf8") };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", content: "" };
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
