import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import {
  FileLargeResultStore,
  PassthroughLargeResultStore,
} from "../../src/context/large-result-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { writeFileTool } from "../../src/tools/write-file.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("write_file tool", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-write-file-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("creates parent directories and writes content", async () => {
    const readTracker = new InMemoryReadTracker();
    const result = await writeFileTool.execute(
      { path: "src/generated.ts", content: "export const value = 42;\n" },
      createContext(workspace, readTracker),
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "src", "generated.ts"), "utf8")).toBe(
      "export const value = 42;\n",
    );
    expect(result.content).toContain("+++ b/src/generated.ts");
    expect(readTracker.getRead(join(workspace, "src", "generated.ts"))).toBeDefined();
  });

  it("stores large write diffs as artifacts", async () => {
    const result = await writeFileTool.execute(
      { path: "large.txt", content: `${"x".repeat(120)}\n` },
      {
        ...createContext(workspace),
        artifactStore: new FileLargeResultStore(workspace, {
          thresholdBytes: 60,
          previewBytes: 20,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Tool result was too large");
    expect(result.metadata?.stored).toBe(true);
    const artifactPath = join(
      workspace,
      String(result.metadata?.artifactPath).replaceAll("/", "\\"),
    );
    expect(await readFile(artifactPath, "utf8")).toContain("x".repeat(120));
  });

  it("is blocked by plan mode through the registry", async () => {
    const registry = new ToolRegistry();
    registry.register(writeFileTool);

    const result = await registry.execute(
      "write_file",
      { path: "x.txt", content: "x" },
      {
        ...createContext(workspace),
        permissionMode: "plan",
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PermissionDenied");
    }
  });

  it("does not overwrite directories", async () => {
    await mkdir(join(workspace, "src"));
    const result = await writeFileTool.execute(
      { path: "src", content: "nope" },
      createContext(workspace),
    );

    expect(result.ok).toBe(false);
    await expect(stat(join(workspace, "src"))).resolves.toMatchObject({});
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
