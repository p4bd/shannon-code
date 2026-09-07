export type ShellSafety = "safe" | "needs_approval" | "dangerous";

export interface ShellAnalysis {
  status: ShellSafety;
  reasons: string[];
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/i,
    reason: "recursive forced removal",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "hard git reset discards worktree changes",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d\b|\bgit\s+clean\s+-[a-z]*d[a-z]*f\b/i,
    reason: "git clean force deletes untracked files",
  },
  {
    pattern: /\bremove-item\b[\s\S]*(?:^|\s)-recurse\b/i,
    reason: "recursive PowerShell removal",
  },
  {
    pattern: /\b(?:del(?:ete)?|rmdir|rd)\b[\s\S]*\/s\b/i,
    reason: "recursive Windows delete",
  },
  {
    pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*-(?:e|enc|encodedcommand)\b/i,
    reason: "encoded PowerShell command hides executable content",
  },
  {
    pattern: /(^|[;&|]\s*)format(?:\.com)?\b/i,
    reason: "disk formatting command",
  },
  {
    pattern: /(^|[;&|]\s*)shutdown\b/i,
    reason: "system shutdown command",
  },
  {
    pattern: /\bcurl\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    reason: "downloaded script piped into shell",
  },
  {
    pattern: /\bwget\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    reason: "downloaded script piped into shell",
  },
  {
    pattern: /\binvoke-webrequest\b[\s\S]*\|\s*(?:invoke-expression|iex)\b/i,
    reason: "downloaded PowerShell content piped into execution",
  },
  {
    pattern: /\biwr\b[\s\S]*\|\s*(?:invoke-expression|iex)\b/i,
    reason: "downloaded PowerShell content piped into execution",
  },
];

const SAFE_PATTERNS: RegExp[] = [
  /^(?:node|npm|pnpm|yarn|bun|git)\s+(?:--version|-v|version)$/i,
  /^npm\s+(?:test|run\s+(?:test|build|typecheck|lint))$/i,
  /^pnpm\s+(?:test|run\s+(?:test|build|typecheck|lint))$/i,
  /^yarn\s+(?:test|run\s+(?:test|build|typecheck|lint))$/i,
  /^npx\s+tsc\s+--noEmit$/i,
  /^git\s+(?:status|diff|log|show|branch)(?:\s+.*)?$/i,
  /^(?:pwd|ls|dir)(?:\s+.*)?$/i,
  /^get-childitem(?:\s+.*)?$/i,
];

const NEEDS_APPROVAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /[<>]/,
    reason: "shell redirection can modify files",
  },
  {
    pattern: /\|\s*(?!findstr\b|select-string\b)/i,
    reason: "pipeline command needs review",
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade)\b/i,
    reason: "package manager command can modify dependencies",
  },
  {
    pattern: /\bgit\s+(?:checkout|switch|merge|rebase|commit|push|pull|clean|reset|restore|stash)\b/i,
    reason: "git command can modify repository state",
  },
  {
    pattern: /\b(?:mkdir|rmdir|copy|cp|move|mv|del|erase|set-content|new-item|remove-item)\b/i,
    reason: "filesystem mutation command",
  },
];

export function analyzeShellCommand(command: string): ShellAnalysis {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return {
      status: "needs_approval",
      reasons: ["empty command"],
    };
  }

  const dangerousReasons = DANGEROUS_PATTERNS.filter(({ pattern }) =>
    pattern.test(normalized),
  ).map(({ reason }) => reason);
  if (dangerousReasons.length > 0) {
    return {
      status: "dangerous",
      reasons: dangerousReasons,
    };
  }

  if (SAFE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      status: "safe",
      reasons: ["recognized read-only or inspection command"],
    };
  }

  const approvalReasons = NEEDS_APPROVAL_PATTERNS.filter(({ pattern }) =>
    pattern.test(normalized),
  ).map(({ reason }) => reason);

  return {
    status: "needs_approval",
    reasons:
      approvalReasons.length > 0
        ? approvalReasons
        : ["unrecognized shell command"],
  };
}
