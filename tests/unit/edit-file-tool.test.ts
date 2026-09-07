import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { editFileTool } from "../../src/tools/edit-file.tool.js";
import { readFileTool } from "../../src/tools/read-file.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("edit_file tool", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-edit-file-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("requires the file to be read first", async () => {
    await writeFile(join(workspace, "example.ts"), "const value = 'foo';\n");

    const result = await editFileTool.execute(
      {
        path: "example.ts",
        oldString: "foo",
        newString: "bar",
      },
      createContext(workspace),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ReadBeforeEditRequired");
    }
  });

  it("blocks edits when the file changed after read", async () => {
    const readTracker = new InMemoryReadTracker();
    const ctx = createContext(workspace, readTracker);
    await writeFile(join(workspace, "example.ts"), "const value = 'foo';\n");
    await readFileTool.execute({ path: "example.ts" }, ctx);
    await writeFile(join(workspace, "example.ts"), "const value = 'external';\n");

    const result = await editFileTool.execute(
      {
        path: "example.ts",
        oldString: "foo",
        newString: "bar",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FileModifiedSinceRead");
    }
  });

  it("requires a unique match unless replaceAll is true", async () => {
    const ctx = createContext(workspace);
    await writeFile(join(workspace, "example.ts"), "foo\nfoo\n");
    await readFileTool.execute({ path: "example.ts" }, ctx);

    const result = await editFileTool.execute(
      {
        path: "example.ts",
        oldString: "foo",
        newString: "bar",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SearchStringNotUnique");
    }
  });

  it("edits a unique string and returns a diff", async () => {
    const ctx = createContext(workspace);
    await writeFile(join(workspace, "example.ts"), "export const value = 'foo';\n");
    await readFileTool.execute({ path: "example.ts" }, ctx);

    const result = await editFileTool.execute(
      {
        path: "example.ts",
        oldString: "foo",
        newString: "bar",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "example.ts"), "utf8")).toContain(
      "bar",
    );
    expect(result.content).toContain("-export const value = 'foo';");
    expect(result.content).toContain("+export const value = 'bar';");
  });

  it("returns a compact contextual diff for large files", async () => {
    const ctx = createContext(workspace);
    const lines = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(workspace, "large.txt"), `${lines.join("\n")}\n`);
    await readFileTool.execute({ path: "large.txt" }, ctx);

    const result = await editFileTool.execute(
      {
        path: "large.txt",
        oldString: "line-40",
        newString: "line-40-updated",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("-line-40");
    expect(result.content).toContain("+line-40-updated");
    expect(result.content).toContain(" line-39");
    expect(result.content).toContain(" line-41");
    expect(result.content).not.toContain("line-1\n");
    expect(result.content).not.toContain("line-80");
  });

  it("uses straight quote fallback for curly quoted content", async () => {
    const ctx = createContext(workspace);
    await writeFile(
      join(workspace, "example.ts"),
      "export const value = \u201cfoo\u201d;\n",
    );
    await readFileTool.execute({ path: "example.ts" }, ctx);

    const result = await editFileTool.execute(
      {
        path: "example.ts",
        oldString: '"foo"',
        newString: '"bar"',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "example.ts"), "utf8")).toContain(
      '"bar"',
    );
    expect(result.metadata?.quoteFallbackUsed).toBe(true);
  });

  it("supports explicit replaceAll", async () => {
    const ctx = createContext(workspace);
    await writeFile(join(workspace, "example.ts"), "foo\nfoo\n");
    await readFileTool.execute({ path: "example.ts" }, ctx);

    const result = await editFileTool.execute(
      {
        path: "example.ts",
        oldString: "foo",
        newString: "bar",
        replaceAll: true,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "example.ts"), "utf8")).toBe(
      "bar\nbar\n",
    );
  });
});

function createContext(
  cwd: string,
  readTracker = new InMemoryReadTracker(),
) {
  return {
    cwd,
    sessionId: "test-session",
    permissionMode: "default" as const,
    readTracker,
    artifactStore: new PassthroughLargeResultStore(),
    logger: new NoopLogger(),
  };
}
