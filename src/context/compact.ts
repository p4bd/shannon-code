import type { ModelMessage } from "../core/model-provider.js";
import { estimateMessagesTokens } from "./token-estimator.js";

export interface CompactOptions {
  recentMessages: number;
}

export interface CompactResult {
  messages: ModelMessage[];
  changed: boolean;
  summary: string;
  compactedMessages: number;
  beforeTokens: number;
  afterTokens: number;
}

export function compactMessages(
  messages: ModelMessage[],
  options: CompactOptions,
): CompactResult {
  const beforeTokens = estimateMessagesTokens(messages);
  const systemMessage = messages.find((message) => message.role === "system");
  const nonSystem = messages.filter((message) => message.role !== "system");

  if (nonSystem.length <= options.recentMessages) {
    return {
      messages: cloneMessages(messages),
      changed: false,
      summary: "No compaction needed.",
      compactedMessages: 0,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  const recentStart = findRecentStartPreservingToolGroups(
    nonSystem,
    options.recentMessages,
  );
  const older = nonSystem.slice(0, recentStart);
  const recent = nonSystem.slice(recentStart);
  const summary = buildSummary(older);
  const compacted: ModelMessage[] = [
    systemMessage ?? {
      role: "system",
      content: "You are Shannon Code, a concise and practical coding agent.",
    },
    {
      role: "assistant",
      content: summary,
    },
    ...cloneMessages(recent),
  ];

  return {
    messages: compacted,
    changed: true,
    summary,
    compactedMessages: older.length,
    beforeTokens,
    afterTokens: estimateMessagesTokens(compacted),
  };
}

function buildSummary(messages: ModelMessage[]): string {
  const artifactPaths = collectMatches(
    messages,
    /\.agent\/artifacts\/[^\s"'`]+/g,
  );
  const outcomeMarkers = collectMatches(
    messages,
    /\b(?:SOAK|DOGFOOD|REAL_E2E)[A-Z0-9_]*\b/g,
  );
  const toolErrorCodes = collectMatches(messages, /"code":\s*"([^"]+)"/g).map(
    (match) => match.replace(/^"code":\s*"|"$/g, ""),
  );
  const userRequests = messages
    .filter((message) => message.role === "user")
    .map((message) => summarizeMessage(message))
    .slice(-8);
  const assistantOutcomes = messages
    .filter(
      (message) =>
        message.role === "assistant" && message.content.trim().length > 0,
    )
    .map((message) => summarizeMessage(message))
    .slice(-8);
  const toolCalls = collectToolCallSummaries(messages).slice(-20);

  const lines = [
    "Conversation summary from compacted context:",
    `- Compacted messages: ${messages.length}`,
    "- Earlier user requests:",
    ...(userRequests.length > 0 ? userRequests : ["  - (none)"]),
    "- Earlier assistant outcomes:",
    ...(assistantOutcomes.length > 0 ? assistantOutcomes : ["  - (none)"]),
    "- Tool calls/actions observed:",
    ...(toolCalls.length > 0 ? toolCalls : ["  - (none)"]),
    "- Important earlier messages:",
    ...messages.slice(-10).map((message) => summarizeMessage(message)),
  ];

  if (artifactPaths.length > 0) {
    lines.push("- Artifact paths:");
    lines.push(...artifactPaths.slice(-10).map((path) => `  - ${path}`));
  }

  if (toolErrorCodes.length > 0) {
    lines.push("- Tool error codes observed:");
    lines.push(
      ...[...new Set(toolErrorCodes)]
        .slice(-10)
        .map((code) => `  - ${code}`),
    );
  }

  if (outcomeMarkers.length > 0) {
    lines.push("- Outcome markers observed:");
    lines.push(
      ...[...new Set(outcomeMarkers)]
        .slice(-20)
        .map((marker) => `  - ${marker}`),
    );
  }

  lines.push(
    "Continue using the recent full messages below as the source of truth for the current task.",
  );
  return lines.join("\n");
}

function summarizeMessage(message: ModelMessage): string {
  const label =
    message.role === "tool"
      ? `tool${message.toolCallId ? `:${message.toolCallId}` : ""}`
      : message.role;
  const content = message.content.replace(/\s+/g, " ").trim();
  const preview =
    content.length <= 240 ? content : `${content.slice(0, 237)}...`;
  return `  - ${label}: ${preview || "(empty)"}`;
}

function collectMatches(messages: ModelMessage[], pattern: RegExp): string[] {
  return messages.flatMap((message) =>
    [...message.content.matchAll(pattern)].map((match) => match[1] ?? match[0]),
  );
}

function collectToolCallSummaries(messages: ModelMessage[]): string[] {
  return messages.flatMap((message) =>
    (message.toolCalls ?? []).map(
      (toolCall) =>
        `  - ${toolCall.name}: ${summarizeValue(toolCall.input ?? toolCall.rawArguments)}`,
    ),
  );
}

function summarizeValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function findRecentStartPreservingToolGroups(
  messages: ModelMessage[],
  recentMessages: number,
): number {
  let start = Math.max(0, messages.length - recentMessages);

  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }

  return start;
}

function cloneMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  }));
}
