import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { grepSearchTool } from "../../src/tools/grep-search.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("grep_search tool", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-grep-search-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(workspace, "src", "index.ts"),
      "export const targetValue = 42;\nexport const other = 1;\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.ts"),
      "export const targetValue = 'dependency';\n",
      "utf8",
    );
    await writeFile(join(workspace, "README.md"), "targetValue docs\n", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("searches workspace files and supports include filters", async () => {
    const result = await grepSearchTool.execute(
      { pattern: "targetValue", path: ".", include: "*.ts" },
      {
        cwd: workspace,
        sessionId: "test-session",
        permissionMode: "default",
        subagentDepth: 0,
        readTracker: new InMemoryReadTracker(),
        artifactStore: new PassthroughLargeResultStore(),
        logger: new NoopLogger(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/index.ts");
    expect(result.content).not.toContain("README.md");
    expect(result.content).not.toContain("node_modules");
  });
});
