import type { ModelPromptSection } from "../core/model-provider.js";
import type { ProjectRules } from "./project-rules.js";
import type { Skill } from "../skills/types.js";

export type PromptSection = ModelPromptSection;

export interface SystemPromptInput {
  cwd: string;
  projectRules?: ProjectRules;
  skills?: Skill[];
  memorySection?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  return formatPromptSections(buildSystemPromptSections(input));
}

export function buildSystemPromptSections(
  input: SystemPromptInput,
): PromptSection[] {
  const sections: PromptSection[] = [
    {
      name: "agent_core",
      cacheable: true,
      content: [
      "You are Shannon Code, a concise and practical coding agent.",
      "Use tools when they help answer accurately. Prefer read_file and list_files before making claims about local files.",
      "run_shell is available for safe inspection commands such as version checks, tests, and builds. Do not run destructive commands.",
      "If a tool returns a recoverable error, adjust your approach instead of stopping immediately.",
      "When you have enough information, give a direct final answer.",
    ].join("\n"),
    },
    {
      name: "workspace",
      cacheable: false,
      content: [
        `Current workspace: ${input.cwd}`,
        `Current date: ${new Date().toISOString().slice(0, 10)}`,
      ].join("\n"),
    },
  ];

  if (input.projectRules?.content) {
    sections.push({
      name: "project_rules",
      cacheable: false,
      content: ["Project rules:", input.projectRules.content].join("\n"),
    });
  }

  if (input.skills && input.skills.length > 0) {
    sections.push({
      name: "skills",
      cacheable: true,
      content: [
        "Available skills:",
        ...input.skills.map((skill) => {
          const tools =
            skill.allowedTools && skill.allowedTools.length > 0
              ? ` tools: ${skill.allowedTools.join(", ")}`
              : " tools: all available";
          return `- ${skill.name} (${skill.mode};${tools}): ${skill.description}`;
        }),
        'Use "/skill <name> [input]" in the CLI to invoke a skill directly.',
      ].join("\n"),
    });
  }

  if (input.memorySection) {
    sections.push({
      name: "memory",
      cacheable: false,
      content: ["Relevant memory:", input.memorySection].join("\n"),
    });
  }

  return sections;
}

export function formatPromptSections(sections: PromptSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}
