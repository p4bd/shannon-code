import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { editFileTool } from "../../src/tools/edit-file.tool.js";
import { grepSearchTool } from "../../src/tools/grep-search.tool.js";
import { listFilesTool } from "../../src/tools/list-files.tool.js";
import { readFileTool } from "../../src/tools/read-file.tool.js";
import { writeFileTool } from "../../src/tools/write-file.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("tool path boundaries", () => {
  let workspace: string;
  let outside: string;
  let outsideFile: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-path-workspace-"));
    outside = await mkdtemp(join(tmpdir(), "shannon-path-outside-"));
    outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "do not touch\n", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("blocks read-style tools from absolute paths outside the workspace", async () => {
    const ctx = createContext();

    const read = await readFileTool.execute({ path: outsideFile }, ctx);
    const list = await listFilesTool.execute({ path: outside }, ctx);
    const grep = await grepSearchTool.execute(
      { pattern: "touch", path: outside },
      ctx,
    );

    expectDenied(read);
    expectDenied(list);
    expectDenied(grep);
  });

  it("blocks write-style tools from absolute paths outside the workspace", async () => {
    const ctx = createContext();
    ctx.readTracker.recordRead({
      path: outsideFile,
      mtimeMs: 0,
      hash: "not-current",
    });

    const write = await writeFileTool.execute(
      { path: outsideFile, content: "changed\n" },
      ctx,
    );
    const edit = await editFileTool.execute(
      {
        path: outsideFile,
        oldString: "do not touch",
        newString: "changed",
      },
      ctx,
    );

    expectDenied(write);
    expectDenied(edit);
    expect(await readFile(outsideFile, "utf8")).toBe("do not touch\n");
  });

  it("blocks traversal through directory symlinks or junctions that point outside", async () => {
    const linkedPath = join(workspace, "linked-out");
    try {
      await symlink(outside, linkedPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES")) {
        return;
      }
      throw error;
    }

    const ctx = createContext();
    const read = await readFileTool.execute({ path: "linked-out/secret.txt" }, ctx);
    const list = await listFilesTool.execute({ path: "linked-out" }, ctx);
    const grep = await grepSearchTool.execute(
      { pattern: "touch", path: "linked-out" },
      ctx,
    );
    const write = await writeFileTool.execute(
      { path: "linked-out/new.txt", content: "changed\n" },
      ctx,
    );

    expectDenied(read);
    expectDenied(list);
    expectDenied(grep);
    expectDenied(write);
    await expect(access(join(outside, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("do not touch\n");
  });

  function createContext() {
    return {
      cwd: workspace,
      sessionId: "test-session",
      permissionMode: "bypassPermissions" as const,
      readTracker: new InMemoryReadTracker(),
      artifactStore: new PassthroughLargeResultStore(),
      logger: new NoopLogger(),
    };
  }
});

function expectDenied(result: Awaited<ReturnType<typeof readFileTool.execute>>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("PermissionDenied");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
