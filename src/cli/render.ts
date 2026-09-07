import { stripVTControlCharacters } from "node:util";
import type { AgentEvent } from "../core/agent.js";

function color(value: string, code: string): string {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined &&
    process.env.FORCE_COLOR !== "0" && process.env.TERM !== "dumb"
    ? `\x1b[${code}m${value}\x1b[0m`
    : value;
}

function rule(): string {
  return color("─".repeat(Math.max(1, Math.min(process.stdout.columns ?? 80, 80) - 1)), "90");
}

function agentPrefix(): string {
  return process.stdout.isTTY ? `${color("● Shannon", "1;36")}\n\n` : "Agent > ";
}

export function formatStartup(cwd: string, model: string, sessionId: string): string {
  return [
    "",
    color("  ,_,     Shannon Code", "1;36"),
    color(" (o,o)    Small code. Clear thinking.", "36"),
    color(" /)_)     Shannon the owl", "36"),
    "",
    `  Model: ${model}`,
    `  Workspace: ${cwd}`,
    color(`  Shannon Code REPL. Session: ${sessionId}`, "90"),
    color("  Type /help for commands, /exit to quit. Ctrl+C interrupts a response.", "90"),
  ].join("\n");
}

export function formatUserPrompt(): string {
  return `\n${rule()}\n${color("You > ", "1;35")}`;
}

export function formatAgentMessage(content: string): string {
  return `\n${agentPrefix()}${content}\n`;
}

export function formatErrorMessage(content: string): string {
  return `\n${color("Error > ", "1;31")}${content}\n`;
}

export function createConsoleEventRenderer(): {
  onEvent(event: AgentEvent): void;
  finish(): void;
} {
  let inAgentMessage = false;
  let lineOpen = false;
  const calls = new Map<string, number>();

  function closeMessage(): void {
    if (lineOpen) process.stdout.write("\n");
    lineOpen = false;
    inAgentMessage = false;
  }

  return {
    onEvent(event) {
      if (event.type === "text_delta") {
        if (!event.delta) return;
        if (!inAgentMessage) {
          process.stdout.write(`\n${agentPrefix()}`);
          inAgentMessage = true;
        }
        process.stdout.write(event.delta);
        lineOpen = !event.delta.endsWith("\n");
        return;
      }

      closeMessage();
      const call = event.toolCall;
      if (!calls.has(call.id)) calls.set(call.id, calls.size + 1);
      const number = calls.get(call.id);
      if (event.type === "tool_start") {
        const raw = typeof call.input === "string"
          ? call.input : JSON.stringify(call.input) ?? "";
        process.stdout.write(
          `\n  ${color(`[tool] ${call.name} #${number} · running`, "33")}\n` +
          `${preview(`input: ${raw}`, 3)}\n`,
        );
        return;
      }

      const status = event.result.ok
        ? "ok"
        : `${event.result.error.code}${event.result.recoverable ? " recoverable" : ""}`;
      process.stdout.write(
        `\n  ${color(`[tool] ${call.name} -> ${status} #${number}`, event.result.ok ? "32" : "1;31")}\n` +
        `${preview(event.result.content, 6)}\n${color("    └─", "90")}\n`,
      );
    },
    finish: closeMessage,
  };
}

function preview(content: string, maxLines: number): string {
  const clean = stripVTControlCharacters(content).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trimEnd();
  const lines = (clean || "(empty)").split("\n");
  const width = Math.max(8, Math.min(process.stdout.columns ?? 100, 100) - 8);
  let truncated = lines.length > maxLines;
  const visible = lines.slice(0, maxLines).map((line) => {
    const chars = Array.from(line.replace(/\t/g, "  "));
    if (chars.length > width) truncated = true;
    return `    │ ${chars.length > width ? chars.slice(0, width - 3).join("") + "..." : chars.join("")}`;
  });
  // ponytail: bounded previews; use a transcript viewer if interactive expansion is needed.
  if (truncated) visible.push("    │ ... (preview truncated; full result in session log)");
  return visible.join("\n");
}
