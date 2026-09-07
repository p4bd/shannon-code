import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContextBudgetStatus } from "../../src/context/budget.js";
import { compactMessages } from "../../src/context/compact.js";
import { FileLargeResultStore } from "../../src/context/large-result-store.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "../../src/context/token-estimator.js";

describe("context management", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-context-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("roughly estimates tokens from text and messages", () => {
    expect(estimateTextTokens("12345678")).toBe(2);
    expect(
      estimateMessagesTokens([
        { role: "system", content: "system" },
        { role: "user", content: "hello world" },
      ]),
    ).toBeGreaterThan(0);
  });

  it("stores large tool results as artifacts with a preview", async () => {
    const store = new FileLargeResultStore(workspace, {
      thresholdBytes: 20,
      previewBytes: 10,
    });

    const result = await store.maybeStore("read_file", "x".repeat(100));

    expect(result.content).toContain("Tool result was too large");
    expect(result.content).toContain(".agent/artifacts/");
    expect(result.metadata?.stored).toBe(true);
    const artifactPath = join(
      workspace,
      String(result.metadata?.artifactPath).replaceAll("/", "\\"),
    );
    expect(await readFile(artifactPath, "utf8")).toBe("x".repeat(100));
  });

  it("keeps the tail of large shell output and the head of other output", async () => {
    const store = new FileLargeResultStore(workspace, {
      thresholdBytes: 20,
      previewBytes: 10,
    });
    const content = `HEAD-${"x".repeat(30)}-TAIL`;

    const shell = await store.maybeStore("run_shell", content);
    const read = await store.maybeStore("read_file", content);

    expect(shell.content).toContain("-TAIL");
    expect(shell.content).not.toContain("HEAD-");
    expect(read.content).toContain("HEAD-");
    expect(read.content).not.toContain("-TAIL");
  });

  it("compacts older messages and preserves recent messages", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "first task" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "second task" },
      { role: "assistant" as const, content: "second answer" },
    ];

    const result = compactMessages(messages, { recentMessages: 2 });

    expect(result.changed).toBe(true);
    expect(result.compactedMessages).toBe(2);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[1]?.content).toContain("Conversation summary");
    expect(result.messages.at(-2)?.content).toBe("second task");
    expect(result.messages.at(-1)?.content).toBe("second answer");
  });

  it("keeps assistant tool calls with their tool results when compacting", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "inspect both files" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "call_a",
            name: "read_file",
            input: { path: "a.txt" },
            rawArguments: JSON.stringify({ path: "a.txt" }),
          },
          {
            id: "call_b",
            name: "read_file",
            input: { path: "b.txt" },
            rawArguments: JSON.stringify({ path: "b.txt" }),
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_a", content: "a" },
      { role: "tool" as const, toolCallId: "call_b", content: "b" },
      { role: "user" as const, content: "continue" },
    ];

    const result = compactMessages(messages, { recentMessages: 2 });

    expect(result.changed).toBe(true);
    expect(result.messages.at(-4)?.role).toBe("assistant");
    expect(result.messages.at(-4)?.toolCalls?.map((call) => call.id)).toEqual([
      "call_a",
      "call_b",
    ]);
    expect(result.messages.at(-3)).toMatchObject({
      role: "tool",
      toolCallId: "call_a",
    });
    expect(result.messages.at(-2)).toMatchObject({
      role: "tool",
      toolCallId: "call_b",
    });
    expect(result.messages.at(-1)).toMatchObject({
      role: "user",
      content: "continue",
    });
  });

  it("keeps important older tool actions in the compact summary", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "inspect and fix the project" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "call_read",
            name: "read_file",
            input: { path: "src/ledger.mjs" },
            rawArguments: JSON.stringify({ path: "src/ledger.mjs" }),
          },
          {
            id: "call_test",
            name: "run_shell",
            input: { command: "npm test" },
            rawArguments: JSON.stringify({ command: "npm test" }),
          },
        ],
      },
      { role: "tool" as const, toolCallId: "call_read", content: "source" },
      {
        role: "tool" as const,
        toolCallId: "call_test",
        content: "SOAK_LEDGER_TEST_PASS_R3",
      },
      {
        role: "assistant" as const,
        content: "Fixed the implementation. SOAK_R3_FIX_OK",
      },
      { role: "user" as const, content: "write docs" },
      { role: "assistant" as const, content: "Wrote docs" },
      { role: "user" as const, content: "create roadmap" },
      { role: "assistant" as const, content: "Created roadmap" },
      { role: "user" as const, content: "final status" },
    ];

    const result = compactMessages(messages, { recentMessages: 2 });
    const summary = result.messages[1]?.content ?? "";

    expect(summary).toContain("Tool calls/actions observed");
    expect(summary).toContain("read_file");
    expect(summary).toContain("src/ledger.mjs");
    expect(summary).toContain("run_shell");
    expect(summary).toContain("npm test");
    expect(summary).toContain("SOAK_LEDGER_TEST_PASS_R3");
    expect(summary).toContain("SOAK_R3_FIX_OK");
  });

  it("reports budget status", () => {
    const status = getContextBudgetStatus(
      [{ role: "user", content: "x".repeat(100) }],
      {
        maxEstimatedTokens: 10,
        autoCompactThreshold: 0.5,
        recentMessages: 2,
      },
    );

    expect(status.shouldCompact).toBe(true);
    expect(status.thresholdTokens).toBe(5);
  });
});
