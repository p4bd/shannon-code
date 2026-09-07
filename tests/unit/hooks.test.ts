import { describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/hooks/config.js";
import { matchesHook, matchesHookPattern } from "../../src/hooks/matcher.js";
import { parseHookOutput } from "../../src/hooks/runner.js";

describe("hook matcher", () => {
  it("matches exact names, wildcard, and prefix patterns", () => {
    expect(matchesHookPattern("read_file", "read_file")).toBe(true);
    expect(matchesHookPattern("read_file", "write_file")).toBe(false);
    expect(matchesHookPattern("*", "anything")).toBe(true);
    expect(matchesHookPattern("mcp__github__*", "mcp__github__create_issue")).toBe(
      true,
    );
    expect(matchesHookPattern("mcp__github__*", "mcp__gitlab__create_issue")).toBe(
      false,
    );
  });

  it("requires event and matcher to both match", () => {
    expect(
      matchesHook({
        hook: {
          event: "PreToolUse",
          matcher: "run_shell",
          command: "node",
          args: [],
          timeoutMs: 5_000,
        },
        event: "PreToolUse",
        toolName: "run_shell",
      }),
    ).toBe(true);
    expect(
      matchesHook({
        hook: {
          event: "PostToolUse",
          matcher: "run_shell",
          command: "node",
          args: [],
          timeoutMs: 5_000,
        },
        event: "PreToolUse",
        toolName: "run_shell",
      }),
    ).toBe(false);
  });
});

describe("hook config", () => {
  it("normalizes hooks.json entries with defaults", () => {
    const config = parseHookConfig({
      hooks: [
        {
          event: "PostToolUse",
          toolName: "edit_file",
          command: "node",
          args: ["hook.mjs"],
        },
      ],
    });

    expect(config.hooks).toEqual([
      {
        event: "PostToolUse",
        matcher: "edit_file",
        command: "node",
        args: ["hook.mjs"],
        timeoutMs: 5_000,
      },
    ]);
  });
});

describe("hook output parser", () => {
  it("parses supported actions", () => {
    expect(parseHookOutput('{"action":"allow"}')).toEqual({ action: "allow" });
    expect(parseHookOutput('{"action":"deny","reason":"blocked"}')).toEqual({
      action: "deny",
      reason: "blocked",
    });
    expect(parseHookOutput('{"action":"modify","toolInput":{"path":"x"}}')).toEqual({
      action: "modify",
      toolInput: { path: "x" },
    });
    expect(parseHookOutput('{"action":"append","message":"done"}')).toEqual({
      action: "append",
      message: "done",
    });
  });

  it("rejects invalid output", () => {
    expect(() => parseHookOutput("not json")).toThrow();
    expect(() => parseHookOutput('{"action":"deny"}')).toThrow();
    expect(() => parseHookOutput('{"action":"append","message":123}')).toThrow();
  });
});

