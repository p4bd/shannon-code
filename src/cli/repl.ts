import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent } from "../core/agent.js";
import type { ModelMessage, ModelProvider } from "../core/model-provider.js";
import type { HookExecutor } from "../hooks/types.js";
import type { DiagnosticsRunner } from "../lsp/diagnostics.js";
import type {
  ToolApprovalPrompt,
  ToolApprovalRequest,
} from "../permissions/approval.js";
import { recallMemories } from "../memory/recall.js";
import { MemoryStore } from "../memory/store.js";
import type { PermissionMode } from "../permissions/modes.js";
import {
  buildPlanExecutionPrompt,
  buildPlanPrompt,
  buildPlanRevisionPrompt,
  PlanStore,
  type StoredPlan,
} from "../plan/store.js";
import type { ProjectRules } from "../prompt/project-rules.js";
import { runSkill } from "../skills/runner.js";
import type { Skill } from "../skills/types.js";
import type { LocalSubagentRunner } from "../subagent/runner.js";
import type { SerializedSession } from "../session/serializer.js";
import { SessionStore } from "../session/store.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ConsoleLogger } from "../utils/logger.js";
import { parseReplCommand, REPL_HELP, type ReplCommand } from "./commands.js";
import { createConsoleEventRenderer, formatAgentMessage, formatStartup, formatUserPrompt } from "./render.js";

export interface ReplOptions {
  cwd: string;
  provider: ModelProvider;
  model?: string;
  sessionStore: SessionStore;
  initialSession?: SerializedSession;
  sessionId: string;
  permissionMode: PermissionMode;
  maxTurns?: number;
  projectRules?: ProjectRules;
  memoryStore: MemoryStore;
  skills: Skill[];
  subagentRunner: LocalSubagentRunner;
  hookRunner?: HookExecutor;
  diagnosticsRunner?: DiagnosticsRunner;
  approvalPrompt?: ToolApprovalPrompt;
  registry?: ToolRegistry;
}

interface ReplState {
  pendingPlan?: StoredPlan;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = createInterface({ input, output });
  const runtimeOptions: ReplOptions = {
    ...options,
    approvalPrompt: createInteractiveApprovalPrompt(rl),
  };
  let agent = createAgent(runtimeOptions, options.initialSession);
  const state: ReplState = {};

  console.log(formatStartup(options.cwd, options.model ?? options.provider.name, agent.getSessionId()));
  if (options.initialSession) {
    printConversationHistory(options.initialSession.messages);
  }

  try {
    while (true) {
      const line = await rl.question(formatUserPrompt());
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const command = parseReplCommand(trimmed);
      if (command) {
        const commandResult = await handleCommand({
          command,
          agent,
          options: runtimeOptions,
          state,
        });

        if (commandResult.agent) {
          agent = commandResult.agent;
        }

        if (commandResult.exit) {
          break;
        }

        continue;
      }

      const renderer = createConsoleEventRenderer();
      const controller = new AbortController();
      const abort = () => controller.abort();
      rl.once("SIGINT", abort);
      let result;
      try {
        result = await agent.run(trimmed, {
          onEvent: renderer.onEvent,
          signal: controller.signal,
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        renderer.finish();
        console.log("Interrupted.");
        await runtimeOptions.sessionStore.saveSession({
          sessionId: agent.getSessionId(),
          messages: agent.getMessages(),
        });
        continue;
      } finally {
        rl.removeListener("SIGINT", abort);
      }
      renderer.finish();
      if (!options.provider.supportsStreaming) {
        console.log(formatAgentMessage(result.content));
      }
      await runtimeOptions.sessionStore.saveSession({
        sessionId: agent.getSessionId(),
        messages: agent.getMessages(),
      });
    }
  } finally {
    rl.close();
  }
}

async function handleCommand(input: {
  command: ReplCommand;
  agent: Agent;
  options: ReplOptions;
  state: ReplState;
}): Promise<{ exit?: boolean; agent?: Agent }> {
  switch (input.command.name) {
    case "help":
      console.log(REPL_HELP);
      return {};
    case "exit":
      await input.options.sessionStore.saveSession({
        sessionId: input.agent.getSessionId(),
        messages: input.agent.getMessages(),
      });
      console.log(`Saved session ${input.agent.getSessionId()}.`);
      return { exit: true };
    case "clear":
      input.agent.clearMessages();
      await input.options.sessionStore.saveSession({
        sessionId: input.agent.getSessionId(),
        messages: input.agent.getMessages(),
      });
      console.log("Conversation context cleared.");
      return {};
    case "cost":
      console.log(formatBudgetStatus(input.agent.getContextBudgetStatus()));
      return {};
    case "compact":
      {
        const result = input.agent.compact();
        await input.options.sessionStore.saveSession({
          sessionId: input.agent.getSessionId(),
          messages: input.agent.getMessages(),
        });
        console.log(
          result.changed
            ? `Compacted ${result.compactedMessages} messages. Estimated tokens: ${result.beforeTokens} -> ${result.afterTokens}.`
            : `No compaction needed. Estimated tokens: ${result.beforeTokens}.`,
        );
      }
      return {};
    case "plan": {
      await handlePlanCommand(input.command, input.agent, input.options, input.state);
      return {};
    }
    case "memory":
      await handleMemoryCommand(input.command.args, input.options);
      return {};
    case "skill": {
      const result = await handleSkillCommand(input.command, input.agent, input.options);
      if (result?.content && !input.options.provider.supportsStreaming) {
        console.log(formatAgentMessage(result.content));
      }
      if (result) {
        await input.options.sessionStore.saveSession({
          sessionId: input.agent.getSessionId(),
          messages: input.agent.getMessages(),
        });
      }
      return {};
    }
    case "resume": {
      let session: SerializedSession | undefined;
      try {
        session = input.command.sessionId
          ? await input.options.sessionStore.loadSession(input.command.sessionId)
          : await input.options.sessionStore.loadLatestSession();
      } catch (error) {
        console.log(
          error instanceof Error
            ? `Could not resume session: ${error.message}`
            : "Could not resume session.",
        );
        return {};
      }

      if (!session) {
        console.log("No session found to resume.");
        return {};
      }

      const agent = createAgent(
        {
          ...input.options,
          sessionId: session.metadata.sessionId,
          permissionMode: input.agent.getPermissionMode(),
        },
        session,
      );
      console.log(`Resumed session ${session.metadata.sessionId}.`);
      printConversationHistory(session.messages);
      return { agent };
    }
  }
}

function printConversationHistory(messages: ModelMessage[]): void {
  for (const message of messages) {
    if (!message.content.trim()) continue;
    if (message.role === "user") console.log(`${formatUserPrompt()}${message.content}`);
    if (message.role === "assistant") console.log(formatAgentMessage(message.content));
  }
}

async function handlePlanCommand(
  command: Extract<ReplCommand, { name: "plan" }>,
  agent: Agent,
  options: ReplOptions,
  state: ReplState,
): Promise<void> {
  const planStore = new PlanStore(options.cwd);

  switch (command.action) {
    case "mode":
      agent.setPermissionMode("plan");
      console.log("Permission mode: plan. Use /plan <task> to create a tracked plan.");
      return;
    case "status":
      if (!state.pendingPlan) {
        console.log("No pending plan.");
        return;
      }
      console.log(
        `Pending plan ${state.pendingPlan.id} (${state.pendingPlan.status}) at ${state.pendingPlan.path}`,
      );
      return;
    case "cancel":
      if (!state.pendingPlan) {
        console.log("No pending plan to cancel.");
        return;
      }
      state.pendingPlan = await planStore.updateStatus(state.pendingPlan, "canceled");
      console.log(`Canceled plan ${state.pendingPlan.id}.`);
      state.pendingPlan = undefined;
      return;
    case "approve":
      if (!state.pendingPlan) {
        console.log("No pending plan to approve.");
        return;
      }
      await approveAndExecutePlan(agent, options, planStore, state);
      return;
    case "revise":
      if (!state.pendingPlan) {
        console.log("No pending plan to revise.");
        return;
      }
      if (command.args.length === 0) {
        console.log("Usage: /plan revise <feedback>");
        return;
      }
      await createOrRevisePlan({
        agent,
        options,
        planStore,
        state,
        task: state.pendingPlan.task,
        prompt: buildPlanRevisionPrompt(state.pendingPlan, command.args),
        executionMode: state.pendingPlan.executionMode,
      });
      return;
    case "start":
      if (command.args.length === 0) {
        console.log("Usage: /plan <task>");
        return;
      }
      await createOrRevisePlan({
        agent,
        options,
        planStore,
        state,
        task: command.args,
        prompt: buildPlanPrompt(command.args),
        executionMode:
          agent.getPermissionMode() === "plan"
            ? options.permissionMode === "plan"
              ? "default"
              : options.permissionMode
            : agent.getPermissionMode(),
      });
      return;
  }
}

async function createOrRevisePlan(input: {
  agent: Agent;
  options: ReplOptions;
  planStore: PlanStore;
  state: ReplState;
  task: string;
  prompt: string;
  executionMode: string;
}): Promise<void> {
  const previousMode = input.agent.getPermissionMode();
  input.agent.setPermissionMode("plan");
  const renderer = createConsoleEventRenderer();
  let result;
  try {
    result = await input.agent.run(input.prompt, { onEvent: renderer.onEvent });
    renderer.finish();
    if (!input.options.provider.supportsStreaming) {
      console.log(formatAgentMessage(result.content));
    }
  } finally {
    input.agent.setPermissionMode(previousMode);
  }

  input.state.pendingPlan = await input.planStore.createPlan({
    sessionId: input.agent.getSessionId(),
    task: input.task,
    content: result.content,
    executionMode: input.executionMode,
  });
  await input.options.sessionStore.saveSession({
    sessionId: input.agent.getSessionId(),
    messages: input.agent.getMessages(),
  });
  console.log(`Plan saved to ${input.state.pendingPlan.path}.`);
  console.log("Next: /plan approve, /plan revise <feedback>, or /plan cancel.");
}

async function approveAndExecutePlan(
  agent: Agent,
  options: ReplOptions,
  planStore: PlanStore,
  state: ReplState,
): Promise<void> {
  if (!state.pendingPlan) {
    return;
  }

  state.pendingPlan = await planStore.updateStatus(state.pendingPlan, "approved");
  const executionMode = toPermissionMode(state.pendingPlan.executionMode);
  const previousMode = agent.getPermissionMode();
  agent.setPermissionMode(executionMode);
  const renderer = createConsoleEventRenderer();
  try {
    const result = await agent.run(buildPlanExecutionPrompt(state.pendingPlan), {
      onEvent: renderer.onEvent,
    });
    renderer.finish();
    if (!options.provider.supportsStreaming) {
      console.log(formatAgentMessage(result.content));
    }
  } finally {
    agent.setPermissionMode(previousMode);
  }

  state.pendingPlan = await planStore.updateStatus(state.pendingPlan, "executed");
  await options.sessionStore.saveSession({
    sessionId: agent.getSessionId(),
    messages: agent.getMessages(),
  });
  console.log(`Executed plan ${state.pendingPlan.id}.`);
  state.pendingPlan = undefined;
}

function toPermissionMode(value: string): PermissionMode {
  return value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "dontAsk"
    ? value
    : "default";
}

function formatBudgetStatus(status: ReturnType<Agent["getContextBudgetStatus"]>): string {
  return [
    `Estimated context tokens: ${status.estimatedTokens}`,
    `Auto-compact threshold: ${status.thresholdTokens}`,
    `Configured max: ${status.maxEstimatedTokens}`,
    `Should compact: ${status.shouldCompact ? "yes" : "no"}`,
  ].join("\n");
}

async function handleMemoryCommand(
  args: string,
  options: ReplOptions,
): Promise<void> {
  const [action = "list", ...rest] = args.trim().split(/\s+/);
  const value = rest.join(" ").trim();

  switch (action.toLowerCase()) {
    case "":
    case "list": {
      const memories = await options.memoryStore.list();
      if (memories.length === 0) {
        console.log("No memories stored.");
        return;
      }

      for (const memory of memories) {
        console.log(`${memory.id.slice(0, 8)}  ${memory.content}`);
      }
      return;
    }
    case "add": {
      if (value.length === 0) {
        console.log("Usage: /memory add <text>");
        return;
      }

      const memory = await options.memoryStore.add(value);
      console.log(`Added memory ${memory.id.slice(0, 8)}.`);
      return;
    }
    case "delete":
    case "del":
    case "remove": {
      if (value.length === 0) {
        console.log("Usage: /memory delete <id>");
        return;
      }

      const deleted = await options.memoryStore.delete(value);
      console.log(
        deleted
          ? `Deleted memory ${deleted.id.slice(0, 8)}.`
          : "No unique memory matched that id.",
      );
      return;
    }
    case "recall": {
      if (value.length === 0) {
        console.log("Usage: /memory recall <query>");
        return;
      }

      const memories = await recallMemories(options.memoryStore, value, {
        provider: options.provider,
      });
      if (memories.length === 0) {
        console.log("No relevant memories found.");
        return;
      }

      for (const memory of memories) {
        console.log(`${memory.id.slice(0, 8)}  ${memory.content}`);
      }
      return;
    }
    default:
      console.log("Usage: /memory add <text> | list | delete <id> | recall <query>");
  }
}

function createAgent(
  options: ReplOptions,
  session: SerializedSession | undefined,
): Agent {
  return new Agent({
    provider: options.provider,
    registry: options.registry ?? createDefaultToolRegistry(),
    cwd: options.cwd,
    sessionId: session?.metadata.sessionId ?? options.sessionId,
    initialMessages: session?.messages,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    projectRules: options.projectRules,
    memoryStore: options.memoryStore,
    skills: options.skills,
    subagentRunner: options.subagentRunner,
    hookRunner: options.hookRunner,
    diagnosticsRunner: options.diagnosticsRunner,
    approvalPrompt: options.approvalPrompt,
    logger: new ConsoleLogger(),
  });
}

function createInteractiveApprovalPrompt(
  rl: ReturnType<typeof createInterface>,
): ToolApprovalPrompt {
  const approvedForSession = new Set<string>();

  return async (request) => {
    const cacheKey = `${request.toolName}:${request.subject}`;
    if (approvedForSession.has(cacheKey)) {
      return true;
    }

    console.log(formatApprovalRequest(request));
    const answer = (
      await rl.question("Approve tool? yes/no/always [y/N/a]: ")
    ).trim().toLowerCase();

    if (answer === "a" || answer === "always") {
      approvedForSession.add(cacheKey);
      return true;
    }

    return answer === "y" || answer === "yes";
  };
}

function formatApprovalRequest(request: ToolApprovalRequest): string {
  const lines = [
    `\nPermission request: ${request.toolName}`,
    `Reason: ${request.reason}`,
    `Subject: ${request.subject}`,
  ];

  if (request.shellAnalysis?.reasons.length) {
    lines.push(`Shell analysis: ${request.shellAnalysis.reasons.join(", ")}`);
  }

  lines.push(`Input: ${summarizeApprovalInput(request.toolInput)}`);
  return lines.join("\n");
}

function summarizeApprovalInput(input: unknown): string {
  const raw = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}...`;
}

async function handleSkillCommand(
  command: Extract<ReplCommand, { name: "skill" }>,
  agent: Agent,
  options: ReplOptions,
) {
  if (!command.skillName) {
    if (options.skills.length === 0) {
      console.log("No skills found in .agent/skills.");
      return undefined;
    }

    for (const skill of options.skills) {
      console.log(`${skill.name}  ${skill.description}`);
    }
    return undefined;
  }

  const skill = options.skills.find((candidate) => candidate.name === command.skillName);
  if (!skill) {
    console.log(`Skill not found: ${command.skillName}`);
    return undefined;
  }

  const renderer = createConsoleEventRenderer();
  const result = await runSkill({
    skill,
    args: command.args,
    agent,
    provider: options.provider,
    cwd: options.cwd,
    sessionId: agent.getSessionId(),
    permissionMode: agent.getPermissionMode(),
    projectRules: options.projectRules,
    memoryStore: options.memoryStore,
    skills: options.skills,
    maxTurns: options.maxTurns,
    hookRunner: options.hookRunner,
    diagnosticsRunner: options.diagnosticsRunner,
    logger: new ConsoleLogger(),
    onEvent: renderer.onEvent,
  });
  renderer.finish();
  return result;
}
