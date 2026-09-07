import type { PermissionMode } from "../permissions/modes.js";

export interface CliArgs {
  prompt?: string;
  help: boolean;
  version: boolean;
  permissionMode: PermissionMode;
  resume?: true | string;
  maxTurns?: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let help = false;
  let version = false;
  let permissionMode: PermissionMode = "default";
  let resume: true | string | undefined;
  let maxTurns: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }

    if (arg === "--yolo") {
      permissionMode = "bypassPermissions";
      continue;
    }

    if (arg === "--plan") {
      permissionMode = "plan";
      continue;
    }

    if (arg === "--accept-edits") {
      permissionMode = "acceptEdits";
      continue;
    }

    if (arg === "--dont-ask") {
      permissionMode = "dontAsk";
      continue;
    }

    if (arg === "--resume") {
      const next = argv[index + 1];
      if (next && looksLikeSessionId(next)) {
        resume = next;
        index += 1;
      } else {
        resume = true;
      }
      continue;
    }

    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      resume = value.length > 0 ? value : true;
      continue;
    }

    if (arg === "--max-turns") {
      const next = argv[index + 1];
      const parsed = parsePositiveInteger(next);
      if (parsed !== undefined) {
        maxTurns = parsed;
        index += 1;
        continue;
      }
    }

    if (arg.startsWith("--max-turns=")) {
      const parsed = parsePositiveInteger(arg.slice("--max-turns=".length));
      if (parsed !== undefined) {
        maxTurns = parsed;
        continue;
      }
    }

    if (arg === "--permission-mode") {
      const next = argv[index + 1];
      if (isPermissionMode(next)) {
        permissionMode = next;
        index += 1;
        continue;
      }
    }

    if (arg.startsWith("--permission-mode=")) {
      const value = arg.slice("--permission-mode=".length);
      if (isPermissionMode(value)) {
        permissionMode = value;
        continue;
      }
    }

    positional.push(arg);
  }

  return {
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
    help,
    version,
    permissionMode,
    resume,
    maxTurns,
  };
}

export const USAGE = `Usage:
  shannon code [options] "your prompt"
  shannon code [options]
  shannon-code [options] "your prompt"
  shannon-code [options]
  npm start -- [options] "your prompt"
  npm start -- [options]

Options:
  --permission-mode <mode>  default | acceptEdits | bypassPermissions | plan | dontAsk
  --yolo                    Alias for --permission-mode bypassPermissions
  --plan                    Alias for --permission-mode plan
  --accept-edits            Alias for --permission-mode acceptEdits
  --dont-ask                Alias for --permission-mode dontAsk
  --resume[=sessionId]      Resume latest session, or the specified session id
  --max-turns <number>      Maximum model/tool loop turns per user prompt

Environment:
  OPENAI_API_KEY    Required API key.
  OPENAI_BASE_URL   Optional OpenAI-compatible base URL.
  OPENAI_MODEL      Optional model name, defaults to gpt-4.1-mini.
`;

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "dontAsk"
  );
}

function looksLikeSessionId(value: string): boolean {
  return /^[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/i.test(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
