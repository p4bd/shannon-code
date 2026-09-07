import { Agent, type AgentEvent, type AgentRunResult } from "../core/agent.js";
import type { ModelProvider } from "../core/model-provider.js";
import type { LargeResultStore } from "../context/large-result-store.js";
import type { ReadTracker } from "../context/read-tracker.js";
import type { HookExecutor } from "../hooks/types.js";
import type { DiagnosticsRunner } from "../lsp/diagnostics.js";
import type { MemoryStore } from "../memory/store.js";
import type { PermissionMode } from "../permissions/modes.js";
import type { ProjectRules } from "../prompt/project-rules.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Logger } from "../utils/logger.js";
import { NoopLogger } from "../utils/logger.js";
import type { Skill } from "./types.js";

export interface SkillRunOptions {
  skill: Skill;
  args: string;
  agent: Agent;
  provider: ModelProvider;
  cwd: string;
  sessionId: string;
  permissionMode: PermissionMode;
  registry?: ToolRegistry;
  projectRules?: ProjectRules;
  memoryStore?: MemoryStore;
  readTracker?: ReadTracker;
  artifactStore?: LargeResultStore;
  skills?: Skill[];
  maxTurns?: number;
  hookRunner?: HookExecutor;
  diagnosticsRunner?: DiagnosticsRunner;
  logger?: Logger;
  onEvent?: (event: AgentEvent) => void;
}

export async function runSkill(
  options: SkillRunOptions,
): Promise<AgentRunResult> {
  const prompt = buildSkillPrompt(options.skill, options.args);
  if (options.skill.mode === "fork") {
    const forkAgent = new Agent({
      provider: options.provider,
      registry: options.registry ?? createDefaultToolRegistry(),
      cwd: options.cwd,
      sessionId: `${options.sessionId}:skill:${options.skill.name}`,
      permissionMode: options.permissionMode,
      projectRules: options.projectRules,
      memoryStore: options.memoryStore,
      skills: options.skills,
      maxTurns: options.maxTurns,
      logger: options.logger ?? new NoopLogger(),
      readTracker: options.readTracker,
      artifactStore: options.artifactStore,
      hookRunner: options.hookRunner,
      diagnosticsRunner: options.diagnosticsRunner,
    });

    return forkAgent.run(prompt, {
      onEvent: options.onEvent,
      allowedTools: options.skill.allowedTools,
    });
  }

  return options.agent.run(prompt, {
    onEvent: options.onEvent,
    allowedTools: options.skill.allowedTools,
  });
}

export function buildSkillPrompt(skill: Skill, args: string): string {
  return [
    `Use the "${skill.name}" skill.`,
    "",
    "Skill instructions:",
    skill.content,
    "",
    args.trim().length > 0 ? `User input:\n${args.trim()}` : "User input:\nRun this skill with the current conversation context.",
  ].join("\n");
}
