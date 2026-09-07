import { Agent } from "../core/agent.js";
import type { ModelProvider } from "../core/model-provider.js";
import type { HookExecutor } from "../hooks/types.js";
import type { DiagnosticsRunner } from "../lsp/diagnostics.js";
import type { MemoryStore } from "../memory/store.js";
import type { ProjectRules } from "../prompt/project-rules.js";
import type { Skill } from "../skills/types.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { fail, ok, type ToolResult } from "../tools/result.js";
import type { SubagentRunInput, SubagentRunner } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Logger } from "../utils/logger.js";
import { NoopLogger } from "../utils/logger.js";
import { loadSubagentConfigs, type SubagentConfig } from "./config.js";

export interface LocalSubagentRunnerOptions {
  provider: ModelProvider;
  cwd: string;
  projectRules?: ProjectRules;
  memoryStore?: MemoryStore;
  skills?: Skill[];
  registry?: ToolRegistry;
  hookRunner?: HookExecutor;
  diagnosticsRunner?: DiagnosticsRunner;
  logger?: Logger;
  maxDepth?: number;
  defaultMaxTurns?: number;
}

export class LocalSubagentRunner implements SubagentRunner {
  private readonly maxDepth: number;
  private readonly defaultMaxTurns: number;
  private readonly logger: Logger;

  constructor(private readonly options: LocalSubagentRunnerOptions) {
    this.maxDepth = options.maxDepth ?? 2;
    this.defaultMaxTurns = options.defaultMaxTurns ?? 4;
    this.logger = options.logger ?? new NoopLogger();
  }

  async run(input: SubagentRunInput): Promise<ToolResult> {
    if (input.depth >= this.maxDepth) {
      return fail({
        code: "PermissionDenied",
        message: "Sub-agent recursion depth limit reached.",
        content: `Sub-agent recursion depth limit reached at depth ${input.depth}.`,
        recoverable: true,
      });
    }

    const config = await this.resolveConfig(input.agentType);
    if (!config) {
      return fail({
        code: "UnknownError",
        message: `Unknown sub-agent type: ${input.agentType}`,
        content: `Unknown sub-agent type "${input.agentType}". Available built-ins: explore, plan, general.`,
        recoverable: true,
      });
    }

    const agent = new Agent({
      provider: this.options.provider,
      registry: this.options.registry ?? createDefaultToolRegistry(),
      cwd: this.options.cwd,
      sessionId: `${input.parentSessionId}:subagent:${config.name}:${input.depth + 1}`,
      permissionMode: config.permissionMode,
      projectRules: this.options.projectRules,
      memoryStore: this.options.memoryStore,
      skills: this.options.skills,
      maxTurns: input.maxTurns ?? this.defaultMaxTurns,
      logger: this.logger,
      subagentRunner: this,
      subagentDepth: input.depth + 1,
      hookRunner: this.options.hookRunner,
      diagnosticsRunner: this.options.diagnosticsRunner,
    });

    const result = await agent.run(buildSubagentPrompt(config, input.prompt), {
      allowedTools: config.allowedTools,
      signal: input.signal,
    });

    return ok(
      [
        `Sub-agent ${config.name} completed.`,
        "",
        result.content,
      ].join("\n"),
      {
        agentType: config.name,
        messages: result.messages.length,
        toolResults: result.toolResults.length,
        stoppedByMaxTurns: result.stoppedByMaxTurns,
      },
    );
  }

  private async resolveConfig(agentType: string): Promise<SubagentConfig | undefined> {
    const configs = await loadSubagentConfigs(this.options.cwd);
    return configs.find((config) => config.name === agentType);
  }
}

function buildSubagentPrompt(config: SubagentConfig, prompt: string): string {
  return [
    config.systemPrompt,
    "",
    "Delegated task:",
    prompt.trim(),
    "",
    "Return a concise summary with relevant files, findings, actions taken, and any remaining risks.",
  ].join("\n");
}
