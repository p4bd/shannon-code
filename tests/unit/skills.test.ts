import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/prompt/system-prompt.js";
import { loadSkills, parseSkill } from "../../src/skills/loader.js";
import { buildSkillPrompt } from "../../src/skills/runner.js";

describe("skills", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-skills-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("parses skill frontmatter", () => {
    const skill = parseSkill({
      fallbackName: "commit",
      path: ".agent/skills/commit/SKILL.md",
      raw: [
        "---",
        "name: commit",
        "description: Write a concise commit summary",
        "allowed_tools: [read_file, run_shell]",
        "mode: fork",
        "---",
        "Inspect changes and draft a commit message.",
      ].join("\n"),
    });

    expect(skill).toMatchObject({
      name: "commit",
      description: "Write a concise commit summary",
      allowedTools: ["read_file", "run_shell"],
      mode: "fork",
      content: "Inspect changes and draft a commit message.",
    });
  });

  it("loads skills from .agent/skills/*/SKILL.md", async () => {
    await mkdir(join(workspace, ".agent", "skills", "commit"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agent", "skills", "commit", "SKILL.md"),
      "---\nname: commit\ndescription: Commit helper\n---\nDraft commit text.",
      "utf8",
    );

    await expect(loadSkills(workspace)).resolves.toMatchObject([
      {
        name: "commit",
        description: "Commit helper",
        mode: "inline",
      },
    ]);
  });

  it("formats skills into the system prompt", () => {
    const prompt = buildSystemPrompt({
      cwd: workspace,
      skills: [
        {
          name: "commit",
          description: "Commit helper",
          allowedTools: ["read_file"],
          mode: "inline",
          path: ".agent/skills/commit/SKILL.md",
          content: "Draft commit text.",
        },
      ],
    });

    expect(prompt).toContain("Available skills:");
    expect(prompt).toContain("commit (inline; tools: read_file): Commit helper");
  });

  it("wraps skill instructions and user input", () => {
    expect(
      buildSkillPrompt(
        {
          name: "commit",
          description: "Commit helper",
          mode: "inline",
          path: ".agent/skills/commit/SKILL.md",
          content: "Draft commit text.",
        },
        "summarize staged files",
      ),
    ).toContain("User input:\nsummarize staged files");
  });
});
