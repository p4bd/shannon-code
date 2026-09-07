import type { HookConfigEntry, HookEvent } from "./types.js";

export function matchesHookPattern(pattern: string, toolName: string | undefined): boolean {
  if (pattern === "*") {
    return true;
  }

  if (!toolName) {
    return false;
  }

  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }

  return pattern === toolName;
}

export function matchesHook(input: {
  hook: HookConfigEntry;
  event: HookEvent;
  toolName?: string;
}): boolean {
  return (
    input.hook.event === input.event &&
    matchesHookPattern(input.hook.matcher, input.toolName)
  );
}

