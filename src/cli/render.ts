import type { AgentEvent } from "../core/agent.js";

const AGENT_PREFIX = "Agent > ";
const ERROR_PREFIX = "Error > ";

export function formatAgentMessage(content: string): string {
  return `${AGENT_PREFIX}${content}`;
}

export function formatErrorMessage(content: string): string {
  return `${ERROR_PREFIX}${content}`;
}

export function createConsoleEventRenderer(): {
  onEvent(event: AgentEvent): void;
  finish(): void;
} {
  let wroteText = false;
  let lineOpen = false;
  let wroteAgentPrefix = false;

  function ensureToolLine(): void {
    if (wroteText && lineOpen) {
      process.stdout.write("\n");
      lineOpen = false;
    }
  }

  function ensureAgentPrefix(): void {
    if (wroteAgentPrefix) {
      return;
    }

    ensureToolLine();
    process.stdout.write(AGENT_PREFIX);
    wroteAgentPrefix = true;
  }

  return {
    onEvent(event) {
      if (event.type === "text_delta") {
        ensureAgentPrefix();
        process.stdout.write(event.delta);
        wroteText = true;
        lineOpen = !event.delta.endsWith("\n");
        return;
      }

      if (event.type === "tool_start") {
        ensureToolLine();
        process.stdout.write(
          `[tool] ${event.toolCall.name} input: ${summarizeInput(event.toolCall.input)}\n`,
        );
        return;
      }

      ensureToolLine();
      const status = event.result.ok
        ? "ok"
        : `${event.result.error.code}${event.result.recoverable ? " recoverable" : ""}`;
      process.stdout.write(
        `[tool] ${event.toolCall.name} -> ${status}: ${summarizeContent(
          event.result.content,
        )}\n`,
      );
    },
    finish() {
      if (wroteText && lineOpen) {
        process.stdout.write("\n");
      }
    },
  };
}

function summarizeInput(input: unknown): string {
  const raw =
    typeof input === "string" ? input : JSON.stringify(input, null, 0) ?? "";
  return truncate(raw.replace(/\s+/g, " "), 160);
}

function summarizeContent(content: string): string {
  return truncate(content.replace(/\s+/g, " ").trim(), 240);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}
