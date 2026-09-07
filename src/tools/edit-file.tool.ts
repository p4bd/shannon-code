import { readFile, stat, writeFile } from "node:fs/promises";
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

const editFileInput = z.object({
  path: z.string().min(1).describe("File path relative to the workspace."),
  oldString: z.string().min(1).describe("Existing non-empty text to replace."),
  newString: z.string().describe("Replacement text."),
  replaceAll: z.boolean().optional().describe("Replace all occurrences; otherwise oldString must be unique."),
});

type EditFileInput = z.infer<typeof editFileInput>;

export const editFileTool: Tool<EditFileInput> = {
  name: "edit_file",
  description:
    "Safely edit a file by replacing an exact string. The file must be read first, and the old string must be unique unless replaceAll is true.",
  inputSchema: jsonSchema(editFileInput),
  inputValidator: editFileInput,
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

    const readRecord = ctx.readTracker.getRead(absolutePath);
    if (!readRecord) {
      return fail({
        code: "ReadBeforeEditRequired",
        message: `Must read file before editing: ${input.path}`,
        content: `Read ${input.path} with read_file before calling edit_file so the edit can be guarded against stale writes.`,
        recoverable: true,
      });
    }

    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return fail({
          code: "FileNotFound",
          message: `Not a file: ${input.path}`,
          recoverable: true,
        });
      }

      const oldContent = await readFile(absolutePath, "utf8");
      const currentHash = sha256(oldContent);
      if (
        fileStat.mtimeMs !== readRecord.mtimeMs ||
        currentHash !== readRecord.hash
      ) {
        return fail({
          code: "FileModifiedSinceRead",
          message: `File changed since it was read: ${input.path}`,
          content: `File changed since it was read: ${input.path}. Read it again before editing.`,
          details: {
            readMtimeMs: readRecord.mtimeMs,
            currentMtimeMs: fileStat.mtimeMs,
            readHash: readRecord.hash,
            currentHash,
          },
          recoverable: true,
        });
      }

      const replacement = replaceContent({
        content: oldContent,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll ?? false,
      });

      if (!replacement.ok) {
        return fail(replacement.error);
      }

      await writeFile(absolutePath, replacement.content, "utf8");
      const updatedStat = await stat(absolutePath);
      ctx.readTracker.recordRead({
        path: absolutePath,
        mtimeMs: updatedStat.mtimeMs,
        hash: sha256(replacement.content),
      });

      const diff = createUnifiedDiff({
        path: input.path,
        oldContent,
        newContent: replacement.content,
      });
      const stored = await ctx.artifactStore.maybeStore("edit_file", diff);

      return ok(stored.content, {
        path: input.path,
        absolutePath,
        replacements: replacement.replacements,
        quoteFallbackUsed: replacement.quoteFallbackUsed,
        mtimeMs: updatedStat.mtimeMs,
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
            : `Failed to edit file: ${input.path}`,
        recoverable: true,
      });
    }
  },
};

type ReplacementResult =
  | {
      ok: true;
      content: string;
      replacements: number;
      quoteFallbackUsed: boolean;
    }
  | {
      ok: false;
      error: Parameters<typeof fail>[0];
    };

function replaceContent(input: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}): ReplacementResult {
  const exactMatches = findMatches(input.content, input.oldString);
  if (exactMatches.length > 0) {
    return applyMatches({
      ...input,
      matches: exactMatches,
      quoteFallbackUsed: false,
    });
  }

  const normalizedMatches = findMatches(
    normalizeQuotes(input.content),
    normalizeQuotes(input.oldString),
  );
  if (normalizedMatches.length === 0) {
    return {
      ok: false,
      error: {
        code: "SearchStringNotFound",
        message: "oldString was not found in the file.",
        content:
          "oldString was not found. Read the file again and use an exact substring from the current content.",
        recoverable: true,
      },
    };
  }

  return applyMatches({
    ...input,
    matches: normalizedMatches,
    quoteFallbackUsed: true,
  });
}

function applyMatches(input: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
  matches: Array<{ start: number; end: number }>;
  quoteFallbackUsed: boolean;
}): ReplacementResult {
  if (!input.replaceAll && input.matches.length > 1) {
    return {
      ok: false,
      error: {
        code: "SearchStringNotUnique",
        message:
          "oldString appears more than once. Provide a more specific oldString or set replaceAll to true.",
        content: `oldString appears ${input.matches.length} times. Provide a more specific oldString or explicitly set replaceAll to true.`,
        details: { occurrences: input.matches.length },
        recoverable: true,
      },
    };
  }

  const matches = input.replaceAll ? input.matches : [input.matches[0]];
  let next = input.content;
  for (const match of [...matches].reverse()) {
    next = `${next.slice(0, match.start)}${input.newString}${next.slice(match.end)}`;
  }

  return {
    ok: true,
    content: next,
    replacements: matches.length,
    quoteFallbackUsed: input.quoteFallbackUsed,
  };
}

function findMatches(
  content: string,
  search: string,
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let start = 0;

  while (start <= content.length) {
    const index = content.indexOf(search, start);
    if (index === -1) {
      break;
    }

    matches.push({ start: index, end: index + search.length });
    start = index + Math.max(search.length, 1);
  }

  return matches;
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
