import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectRules } from "../../src/prompt/project-rules.js";

describe("project rules", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-rules-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("loads AGENTS.md, CLAUDE.md, .agent/rules, and @path includes", async () => {
    await mkdir(join(workspace, "docs"), { recursive: true });
    await mkdir(join(workspace, ".agent", "rules"), { recursive: true });
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Use concise Chinese replies.\n@docs/shared.md\n",
      "utf8",
    );
    await writeFile(join(workspace, "CLAUDE.md"), "Legacy rule.\n", "utf8");
    await writeFile(join(workspace, "docs", "shared.md"), "Included rule.\n", "utf8");
    await writeFile(
      join(workspace, ".agent", "rules", "local.md"),
      "Local agent rule.\n",
      "utf8",
    );

    const rules = await loadProjectRules(workspace);

    expect(rules.content).toContain("Use concise Chinese replies.");
    expect(rules.content).toContain("Legacy rule.");
    expect(rules.content).toContain("Local agent rule.");
    expect(rules.content).toContain("Included rule.");
    expect(rules.content).toContain("[Included from docs/shared.md]");
  });
});
