import { describe, expect, it } from "vitest";
import { createPromptCacheControl } from "../../src/prompt/cache.js";
import {
  buildSystemPrompt,
  buildSystemPromptSections,
} from "../../src/prompt/system-prompt.js";

describe("prompt caching sections", () => {
  it("separates static and dynamic system prompt sections", () => {
    const sections = buildSystemPromptSections({
      cwd: "C:/work/project",
      projectRules: {
        sections: [{ source: "AGENTS.md", content: "Use tests." }],
        content: "Use tests.",
      },
      memorySection: "- Prefer vitest",
      skills: [
        {
          name: "commit",
          description: "Commit helper",
          mode: "inline",
          path: ".agent/skills/commit/SKILL.md",
          allowedTools: ["read_file"],
          content: "Draft commit text.",
        },
      ],
    });

    expect(sections.find((section) => section.name === "agent_core")?.cacheable).toBe(
      true,
    );
    expect(sections.find((section) => section.name === "skills")?.cacheable).toBe(
      true,
    );
    expect(sections.find((section) => section.name === "workspace")?.cacheable).toBe(
      false,
    );
    expect(
      sections.find((section) => section.name === "project_rules")?.cacheable,
    ).toBe(false);
    expect(sections.find((section) => section.name === "memory")?.cacheable).toBe(
      false,
    );
    expect(buildSystemPrompt({ cwd: "C:/work/project" })).toContain(
      "Current workspace: C:/work/project",
    );
  });

  it("builds cache keys from static sections only", () => {
    const first = createPromptCacheControl(
      buildSystemPromptSections({
        cwd: "C:/one",
        memorySection: "dynamic memory A",
      }),
    );
    const second = createPromptCacheControl(
      buildSystemPromptSections({
        cwd: "C:/two",
        memorySection: "dynamic memory B",
      }),
    );
    const withSkill = createPromptCacheControl(
      buildSystemPromptSections({
        cwd: "C:/two",
        skills: [
          {
            name: "review",
            description: "Review helper",
            mode: "inline",
            path: ".agent/skills/review/SKILL.md",
            content: "Review code.",
          },
        ],
      }),
    );

    expect(first?.key).toBe(second?.key);
    expect(withSkill?.key).not.toBe(first?.key);
    expect(withSkill?.sectionNames).toEqual(["agent_core", "skills"]);
  });
});

