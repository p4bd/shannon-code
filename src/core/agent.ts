import { randomUUID } from "node:crypto";
import {
  InMemoryReadTracker,
  type ReadTracker,
} from "../context/read-tracker.js";
import {
  FileLargeResultStore,
  type LargeResultStore,
} from "../context/large-result-store.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  getContextBudgetStatus,
  type ContextBudgetOptions,
  type ContextBudgetStatus,
} from "../context/budget.js";
import {
  compactMessages,
  type CompactResult,
} from "../context/compact.js";
import { formatMemoryPromptSection } from "../memory/prompt-section.js";
import { recallMemories } from "../memory/recall.js";
import type { MemoryStore } from "../memory/store.js";
import type { HookExecutor } from "../hooks/types.js";
import type { DiagnosticsRunner } from "../lsp/diagnostics.js";
import type { ToolApprovalPrompt } from "../permissions/approval.js";
import type { PermissionMode } from "../permissions/modes.js";
import type { ProjectRules } from "../prompt/project-rules.js";
import { createPromptCacheControl } from "../prompt/cache.js";
import {
  buildSystemPromptSections,
  formatPromptSections,
} from "../prompt/system-prompt.js";
import type { Skill } from "../skills/types.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { fail, serializeToolResult, type ToolResult } from "../tools/result.js";
import type { SubagentRunner, ToolContext } from "../tools/types.js";
import { NoopLogger, type Logger } from "../utils/logger.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelToolCall,
} from "./model-provider.js";
import { ProviderError } from "./errors.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface AgentOptions {
  provider: ModelProvider;
  registry?: ToolRegistry;
  cwd: string;
  sessionId?: string;
  initialMessages?: ModelMessage[];
  maxTurns?: number;
  permissionMode?: PermissionMode;
  readTracker?: ReadTracker;
  artifactStore?: LargeResultStore;
  contextBudget?: Partial<ContextBudgetOptions>;
  projectRules?: ProjectRules;
  memoryStore?: MemoryStore;
  memoryRecallLimit?: number;
  skills?: Skill[];
  subagentRunner?: SubagentRunner;
  subagentDepth?: number;
  hookRunner?: HookExecutor;
  diagnosticsRunner?: DiagnosticsRunner;
  approvalPrompt?: ToolApprovalPrompt;
  logger?: Logger;
}

export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolCall: ModelToolCall }
  | { type: "tool_result"; toolCall: ModelToolCall; result: ToolResult };

export interface AgentRunOptions {
  onEvent?: (event: AgentEvent) => void;
  allowedTools?: string[];
  signal?: AbortSignal;
}

export interface AgentRunResult {
  content: string;
  messages: ModelMessage[];
  toolResults: Array<{
    toolCall: ModelToolCall;
    result: ToolResult;
  }>;
  stoppedByMaxTurns: boolean;
}

const DEFAULT_MAX_TURNS = 8;
const MAX_IDENTICAL_FAILED_TOOL_ATTEMPTS = 2;

export class Agent {
  private readonly provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly maxTurns: number;
  private permissionMode: PermissionMode;
  private readonly readTracker: ReadTracker;
  private readonly artifactStore: LargeResultStore;
  private readonly contextBudget: ContextBudgetOptions;
  private readonly projectRules?: ProjectRules;
  private readonly memoryStore?: MemoryStore;
  private readonly memoryRecallLimit: number;
  private readonly skills: Skill[];
  private readonly subagentRunner?: SubagentRunner;
  private readonly subagentDepth: number;
  private readonly hookRunner?: HookExecutor;
  private readonly diagnosticsRunner?: DiagnosticsRunner;
  private readonly approvalPrompt?: ToolApprovalPrompt;
  private readonly logger: Logger;
  private messages: ModelMessage[];

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.registry = options.registry ?? createDefaultToolRegistry();
    this.cwd = options.cwd;
    this.sessionId = options.sessionId ?? randomUUID();
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.permissionMode = options.permissionMode ?? "default";
    this.readTracker = options.readTracker ?? new InMemoryReadTracker();
    this.artifactStore = options.artifactStore ?? new FileLargeResultStore(this.cwd);
    this.contextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      ...options.contextBudget,
    };
    this.projectRules = options.projectRules;
    this.memoryStore = options.memoryStore;
    this.memoryRecallLimit = options.memoryRecallLimit ?? 5;
    this.skills = options.skills ?? [];
    this.subagentRunner = options.subagentRunner;
    this.subagentDepth = options.subagentDepth ?? 0;
    this.hookRunner = options.hookRunner;
    this.diagnosticsRunner = options.diagnosticsRunner;
    this.approvalPrompt = options.approvalPrompt;
    this.logger = options.logger ?? new NoopLogger();
    this.messages = normalizeInitialMessages(
      options.initialMessages,
      this.buildSystemMessage(),
    );
  }

  async run(
    prompt: string,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const toolResults: AgentRunResult["toolResults"] = [];
    const failedToolAttempts = new Map<string, number>();
    options.signal?.throwIfAborted();
    await this.refreshSystemPrompt(prompt, options.signal);
    this.messages.push({ role: "user", content: prompt });

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      options.signal?.throwIfAborted();
      const response = await this.createModelResponseWithCompactionRetry(
        options.onEvent,
        options.allowedTools,
        options.signal,
      );

      this.messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      if (response.toolCalls.length === 0) {
        const content = await this.applyAgentFinishHooks(response.content);
        if (content !== response.content) {
          this.replaceLastAssistantContent(content);
        }

        return {
          content,
          messages: this.getMessages(),
          toolResults,
          stoppedByMaxTurns: false,
        };
      }

      const currentToolResults = response.stopReason === "length"
        ? this.rejectTruncatedToolCalls(response.toolCalls, options.onEvent)
        : await this.executeToolCalls(
            response.toolCalls,
            options.onEvent,
            options.allowedTools,
            failedToolAttempts,
            options.signal,
          );
      for (const toolResult of currentToolResults) {
        toolResults.push(toolResult);
        this.messages.push({
          role: "tool",
          toolCallId: toolResult.toolCall.id,
          content: serializeToolResult(toolResult.result),
        });
      }
    }

    const initialContent = `Stopped after ${this.maxTurns} turns. The model may need a smaller task or more turns.`;
    this.messages.push({ role: "assistant", content: initialContent });
    const content = await this.applyAgentFinishHooks(initialContent);
    if (content !== initialContent) {
      this.replaceLastAssistantContent(content);
    }

    return {
      content,
      messages: this.getMessages(),
      toolResults,
      stoppedByMaxTurns: true,
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getMessages(): ModelMessage[] {
    return this.messages.map(cloneMessage);
  }

  replaceMessages(messages: ModelMessage[]): void {
    this.messages = normalizeInitialMessages(messages, this.buildSystemMessage());
  }

  clearMessages(): void {
    this.messages = normalizeInitialMessages(undefined, this.buildSystemMessage());
  }

  compact(): CompactResult {
    const result = compactMessages(this.messages, {
      recentMessages: this.contextBudget.recentMessages,
    });
    this.messages = result.messages;
    return result;
  }

  getContextBudgetStatus(): ContextBudgetStatus {
    return getContextBudgetStatus(this.messages, this.contextBudget);
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(permissionMode: PermissionMode): void {
    this.permissionMode = permissionMode;
  }

  private async createModelResponse(input: {
    messages: ModelMessage[];
    tools: ReturnType<ToolRegistry["getModelToolDefinitions"]>;
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
  }) {
    if (!input.onEvent || !this.provider.supportsStreaming) {
      return this.provider.createMessage({
        messages: input.messages,
        tools: input.tools,
        signal: input.signal,
      });
    }

    let finalResponse:
      | Awaited<ReturnType<ModelProvider["createMessage"]>>
      | undefined;

    for await (const event of this.provider.createMessageStream({
      messages: input.messages,
      tools: input.tools,
      signal: input.signal,
    })) {
      if (event.type === "text_delta") {
        input.onEvent(event);
      } else {
        finalResponse = event.response;
      }
    }

    return finalResponse ?? { content: "", toolCalls: [] };
  }

  private async createModelResponseWithCompactionRetry(
    onEvent: ((event: AgentEvent) => void) | undefined,
    allowedTools: string[] | undefined,
    signal: AbortSignal | undefined,
  ) {
    this.autoCompactIfNeeded();
    const tools = this.registry.getModelToolDefinitions(allowedTools);

    try {
      return await this.createModelResponse({
        messages: this.messages,
        tools,
        onEvent,
        signal,
      });
    } catch (error) {
      if (!isPromptTooLongError(error)) {
        throw error;
      }

      const compactResult = this.compact();
      if (!compactResult.changed) {
        throw error;
      }

      this.logger.warn("Prompt too long; compacted context and retrying once.", {
        beforeTokens: compactResult.beforeTokens,
        afterTokens: compactResult.afterTokens,
      });

      return this.createModelResponse({
        messages: this.messages,
        tools,
        onEvent,
        signal,
      });
    }
  }

  private autoCompactIfNeeded(): void {
    const status = this.getContextBudgetStatus();
    if (!status.shouldCompact) {
      return;
    }

    const result = this.compact();
    if (result.changed) {
      this.logger.info("Auto-compacted conversation context.", {
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        compactedMessages: result.compactedMessages,
      });
    }
  }

  private async executeToolCalls(
    toolCalls: ModelToolCall[],
    onEvent: ((event: AgentEvent) => void) | undefined,
    allowedTools: string[] | undefined,
    failedToolAttempts: Map<string, number>,
    signal: AbortSignal | undefined,
  ): Promise<AgentRunResult["toolResults"]> {
    const results: AgentRunResult["toolResults"] = [];

    for (let index = 0; index < toolCalls.length; ) {
      const parallelBatch = collectParallelBatch({
        toolCalls,
        startIndex: index,
        registry: this.registry,
      });

      if (parallelBatch.length > 0) {
        const batchResults = await Promise.all(
          parallelBatch.map((toolCall) =>
            this.executeSingleTool(
              toolCall,
              onEvent,
              allowedTools,
              failedToolAttempts,
              signal,
            ),
          ),
        );
        results.push(...batchResults);
        index += parallelBatch.length;
        continue;
      }

      results.push(
        await this.executeSingleTool(
          toolCalls[index]!,
          onEvent,
          allowedTools,
          failedToolAttempts,
          signal,
        ),
      );
      index += 1;
    }

    return results;
  }

  private async executeSingleTool(
    toolCall: ModelToolCall,
    onEvent: ((event: AgentEvent) => void) | undefined,
    allowedTools?: string[],
    failedToolAttempts?: Map<string, number>,
    signal?: AbortSignal,
  ): Promise<AgentRunResult["toolResults"][number]> {
    signal?.throwIfAborted();
    this.logger.debug("Executing tool", {
      tool: toolCall.name,
      sessionId: this.sessionId,
    });
    onEvent?.({ type: "tool_start", toolCall });
    const retrySignature = getToolRetrySignature(toolCall);
    const priorFailures = failedToolAttempts?.get(retrySignature) ?? 0;
    if (priorFailures >= MAX_IDENTICAL_FAILED_TOOL_ATTEMPTS) {
      const result = fail({
        code: "UnknownError",
        message: `Retry chain limit reached for tool "${toolCall.name}".`,
        content: [
          `Retry chain limit reached for tool "${toolCall.name}".`,
          `The same tool input has already failed ${priorFailures} times in this run.`,
          "Change the tool input or use a different diagnostic tool before retrying.",
        ].join("\n"),
        suggestion:
          "Use the previous recoverable tool errors to change strategy instead of repeating the identical tool call.",
        details: {
          tool: toolCall.name,
          input: toolCall.input,
          priorFailures,
          retryLimit: MAX_IDENTICAL_FAILED_TOOL_ATTEMPTS,
        },
      });
      onEvent?.({ type: "tool_result", toolCall, result });
      return { toolCall, result };
    }

    if (allowedTools && !allowedTools.includes(toolCall.name)) {
      const result = {
        ok: false as const,
        error: {
          code: "PermissionDenied" as const,
          message: `Tool "${toolCall.name}" is not allowed for the active skill.`,
        },
        content: `Tool "${toolCall.name}" is not allowed for the active skill. Allowed tools: ${allowedTools.join(", ")}`,
        recoverable: true,
      };
      recordToolFailure({
        failedToolAttempts,
        retrySignature,
        result,
      });
      onEvent?.({ type: "tool_result", toolCall, result });
      return { toolCall, result };
    }

    const result = await this.registry.execute(
      toolCall.name,
      toolCall.input,
      this.createToolContext(signal),
    );
    recordToolFailure({
      failedToolAttempts,
      retrySignature,
      result,
      resetAllOnSuccess: this.registry.get(toolCall.name)?.readOnly === false,
    });
    onEvent?.({ type: "tool_result", toolCall, result });
    return { toolCall, result };
  }

  private createToolContext(abortSignal?: AbortSignal): ToolContext {
    return {
      cwd: this.cwd,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      subagentDepth: this.subagentDepth,
      subagentRunner: this.subagentRunner,
      hookRunner: this.hookRunner,
      diagnosticsRunner: this.diagnosticsRunner,
      approvalPrompt: this.approvalPrompt,
      abortSignal,
      readTracker: this.readTracker,
      artifactStore: this.artifactStore,
      logger: this.logger,
    };
  }

  private async refreshSystemPrompt(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const memorySection = this.memoryStore
      ? formatMemoryPromptSection(
          await recallMemories(this.memoryStore, prompt, {
            provider: this.provider,
            limit: this.memoryRecallLimit,
            signal,
          }),
        )
      : undefined;

    this.messages[0] = this.buildSystemMessage(memorySection);
  }

  private rejectTruncatedToolCalls(
    toolCalls: ModelToolCall[],
    onEvent: ((event: AgentEvent) => void) | undefined,
  ): AgentRunResult["toolResults"] {
    return toolCalls.map((toolCall) => {
      const result = fail({
        code: "TruncatedToolCall",
        message: `Tool "${toolCall.name}" was not executed because the model response was truncated.`,
        suggestion: "Reissue the tool call with complete arguments.",
      });
      onEvent?.({ type: "tool_result", toolCall, result });
      return { toolCall, result };
    });
  }

  private buildSystemMessage(memorySection?: string): ModelMessage {
    const sections = buildSystemPromptSections({
      cwd: this.cwd,
      projectRules: this.projectRules,
      skills: this.skills,
      memorySection: memorySection && memorySection.length > 0 ? memorySection : undefined,
    });
    const message: ModelMessage = {
      role: "system",
      content: formatPromptSections(sections),
    };

    if (this.provider.supportsPromptCaching) {
      const cacheControl = createPromptCacheControl(sections);
      if (cacheControl) {
        message.cacheControl = cacheControl;
        message.promptSections = sections.map((section) => ({ ...section }));
      }
    }

    return message;
  }

  private async applyAgentFinishHooks(content: string): Promise<string> {
    const result = await this.hookRunner?.runOnAgentFinish({
      cwd: this.cwd,
      sessionId: this.sessionId,
    });
    const messages = result?.appendMessages ?? [];
    if (messages.length === 0) {
      return content;
    }

    return appendHookMessages(content, messages);
  }

  private replaceLastAssistantContent(content: string): void {
    const index = this.messages.length - 1;
    const last = this.messages[index];
    if (!last || last.role !== "assistant") {
      return;
    }

    this.messages[index] = { ...last, content };
  }
}

function collectParallelBatch(input: {
  toolCalls: ModelToolCall[];
  startIndex: number;
  registry: ToolRegistry;
}): ModelToolCall[] {
  const batch: ModelToolCall[] = [];

  for (let index = input.startIndex; index < input.toolCalls.length; index += 1) {
    const toolCall = input.toolCalls[index]!;
    const tool = input.registry.get(toolCall.name);
    if (!tool?.readOnly || tool.concurrencySafe === false) {
      break;
    }

    batch.push(toolCall);
  }

  return batch.length > 1 ? batch : [];
}

function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }

  return /context_length|maximum context|too many tokens|prompt(?: is)? too long|token limit/i.test(
    error.message,
  );
}

function normalizeInitialMessages(
  messages: ModelMessage[] | undefined,
  systemMessage: ModelMessage,
): ModelMessage[] {
  if (!messages || messages.length === 0) {
    return [cloneMessage(systemMessage)];
  }

  const copied = messages.map(cloneMessage);
  if (copied[0]?.role !== "system") {
    copied.unshift(cloneMessage(systemMessage));
  } else {
    copied[0] = cloneMessage(systemMessage);
  }

  return copied;
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    promptSections: message.promptSections?.map((section) => ({ ...section })),
    cacheControl: message.cacheControl
      ? {
          ...message.cacheControl,
          sectionNames: [...message.cacheControl.sectionNames],
        }
      : undefined,
  };
}

function appendHookMessages(content: string, messages: string[]): string {
  const filtered = messages.map((message) => message.trim()).filter(Boolean);
  if (filtered.length === 0) {
    return content;
  }

  return [content, "", "Hook messages:", ...filtered].join("\n");
}

function recordToolFailure(
  input: {
    failedToolAttempts: Map<string, number> | undefined;
    retrySignature: string;
    result: ToolResult;
    resetAllOnSuccess?: boolean;
  },
): void {
  if (!input.failedToolAttempts) {
    return;
  }

  if (input.result.ok) {
    if (input.resetAllOnSuccess) {
      input.failedToolAttempts.clear();
      return;
    }

    input.failedToolAttempts.delete(input.retrySignature);
    return;
  }

  if (!input.result.recoverable) {
    input.failedToolAttempts.delete(input.retrySignature);
    return;
  }

  input.failedToolAttempts.set(
    input.retrySignature,
    (input.failedToolAttempts.get(input.retrySignature) ?? 0) + 1,
  );
}

function getToolRetrySignature(toolCall: ModelToolCall): string {
  return `${toolCall.name}:${stableStringify(toolCall.input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
