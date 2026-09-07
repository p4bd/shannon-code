import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { readFileTool } from "../../src/tools/read-file.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("read_file tool", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-read-file-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("reads workspace files and records mtime/hash", async () => {
    await writeFile(join(workspace, "example.txt"), "alpha\nbeta\n", "utf8");
    const readTracker = new InMemoryReadTracker();

    const result = await readFileTool.execute(
      { path: "example.txt" },
      {
        cwd: workspace,
        sessionId: "test-session",
        permissionMode: "default",
        readTracker,
        artifactStore: new PassthroughLargeResultStore(),
        logger: new NoopLogger(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("alpha");
    expect(readTracker.getRead(join(workspace, "example.txt"))?.hash).toHaveLength(
      64,
    );
  });

  it("blocks paths outside the workspace", async () => {
    const result = await readFileTool.execute(
      { path: "../outside.txt" },
      {
        cwd: workspace,
        sessionId: "test-session",
        permissionMode: "default",
        readTracker: new InMemoryReadTracker(),
        artifactStore: new PassthroughLargeResultStore(),
        logger: new NoopLogger(),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PermissionDenied");
    }
  });
});
