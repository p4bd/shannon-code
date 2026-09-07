import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { listFilesTool } from "../../src/tools/list-files.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("list_files tool", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-list-files-"));
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.js"),
      "module.exports = {};",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lists files recursively from the workspace", async () => {
    const result = await listFilesTool.execute(
      { path: ".", recursive: true },
      {
        cwd: workspace,
        sessionId: "test-session",
        permissionMode: "default",
        readTracker: new InMemoryReadTracker(),
        artifactStore: new PassthroughLargeResultStore(),
        logger: new NoopLogger(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/");
    expect(result.content).toContain("src/index.ts");
    expect(result.content).not.toContain("node_modules");
  });
});
