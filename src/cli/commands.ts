export type ReplCommand =
  | { name: "help" }
  | { name: "exit" }
  | { name: "clear" }
  | { name: "cost" }
  | { name: "compact" }
  | { name: "plan"; action: PlanCommandAction; args: string }
  | { name: "memory"; args: string }
  | { name: "skill"; skillName?: string; args: string }
  | { name: "resume"; sessionId?: string };

export type PlanCommandAction =
  | "mode"
  | "start"
  | "approve"
  | "revise"
  | "cancel"
  | "status";

export function parseReplCommand(line: string): ReplCommand | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [rawName = "", ...rest] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
    case "?":
      return { name: "help" };
    case "exit":
    case "quit":
      return { name: "exit" };
    case "clear":
      return { name: "clear" };
    case "cost":
      return { name: "cost" };
    case "compact":
      return { name: "compact" };
    case "plan":
      return parsePlanCommand(rest);
    case "memory":
      return { name: "memory", args };
    case "skill":
      return rest.length > 0
        ? { name: "skill", skillName: rest[0], args: rest.slice(1).join(" ").trim() }
        : { name: "skill", args: "" };
    case "resume":
      return args.length > 0
        ? { name: "resume", sessionId: args }
        : { name: "resume" };
    default:
      return { name: "help" };
  }
}

export const REPL_HELP = `Commands:
  /help            Show commands.
  /exit            Exit the REPL.
  /clear           Clear current conversation context.
  /cost            Show rough context token budget.
  /compact         Compact older conversation context.
  /plan            Enter plan mode, or /plan <task> to create a plan.
  /plan approve    Approve and execute the pending plan.
  /plan revise     Revise the pending plan with feedback.
  /plan cancel     Cancel the pending plan.
  /memory          add <text> | list | delete <id> | recall <query>.
  /skill           List skills or run /skill <name> [input].
  /resume [id]     Resume latest session or a specific session id.
`;

function parsePlanCommand(rest: string[]): ReplCommand {
  if (rest.length === 0) {
    return { name: "plan", action: "mode", args: "" };
  }

  const [first = "", ...tail] = rest;
  const args = tail.join(" ").trim();
  switch (first.toLowerCase()) {
    case "approve":
    case "execute":
      return { name: "plan", action: "approve", args };
    case "revise":
      return { name: "plan", action: "revise", args };
    case "cancel":
      return { name: "plan", action: "cancel", args };
    case "status":
      return { name: "plan", action: "status", args };
    default:
      return { name: "plan", action: "start", args: rest.join(" ").trim() };
  }
}
