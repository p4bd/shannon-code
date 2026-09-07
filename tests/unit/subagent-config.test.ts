import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_SUBAGENTS,
  loadSubagentConfigs,
  parseSubagentConfig,
} from "../../src/subagent/config.js";

describe("subagent config", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-subagent-config-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("defines built-in explore, plan, and general agents", () => {
    expect(BUILT_IN_SUBAGENTS.map((agent) => agent.name)).toEqual([
      "explore",
      "plan",
      "general",
    ]);
    expect(BUILT_IN_SUBAGENTS.find((agent) => agent.name === "explore")?.allowedTools).toEqual([
      "read_file",
      "list_files",
      "grep_search",
    ]);
    expect(BUILT_IN_SUBAGENTS.find((agent) => agent.name === "general")?.allowedTools).not.toContain(
      "agent",
    );
  });

  it("parses custom agent frontmatter", () => {
    const config = parseSubagentConfig({
      fallbackName: "reviewer",
      path: ".agent/agents/reviewer.md",
      raw: [
        "---",
        "name: reviewer",
        "description: Review code",
        "allowed_tools: [read_file, grep_search]",
        "permission_mode: plan",
        "---",
        "Review the current code carefully.",
      ].join("\n"),
    });

    expect(config).toMatchObject({
      name: "reviewer",
      description: "Review code",
      allowedTools: ["read_file", "grep_search"],
      permissionMode: "plan",
      builtIn: false,
    });
  });

  it("loads custom agents from .agent/agents/*.md", async () => {
    await mkdir(join(workspace, ".agent", "agents"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review code\n---\nReview files.",
      "utf8",
    );

    const configs = await loadSubagentConfigs(workspace);

    expect(configs.some((config) => config.name === "explore")).toBe(true);
    expect(configs.some((config) => config.name === "reviewer")).toBe(true);
  });
});
