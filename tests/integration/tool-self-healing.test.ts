import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";
import type { ToolResult } from "../../src/tools/result.js";

describe("tool error self-healing", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-self-healing-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lets the model recover from FileNotFound by listing and retrying the exact path", async () => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "app.ts"), "export const app = 1;\n", "utf8");

    const provider = new MissingFileRecoveryProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 5 });

    const result = await agent.run("Read src/ap.ts.");

    expect(result.content).toBe("Recovered by reading src/app.ts.");
    expect(result.toolResults.map((entry) => entry.toolCall.name)).toEqual([
      "read_file",
      "list_files",
      "read_file",
    ]);
  });

  it("lets the model recover from edit search misses by rereading and retrying", async () => {
    await writeFile(join(workspace, "target.txt"), "alpha\n", "utf8");

    const provider = new EditSearchRecoveryProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 6,
      permissionMode: "acceptEdits",
    });

    const result = await agent.run("Change alpha to beta.");

    expect(result.content).toBe("Edited after rereading.");
    expect(result.toolResults.map((entry) => entry.toolCall.name)).toEqual([
      "read_file",
      "edit_file",
      "read_file",
      "edit_file",
    ]);
  });

  it("lets the model recover from shell failure using stdout and stderr", async () => {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify(
        {
          scripts: {
            test: "node -e \"console.error('boom'); process.exit(1)\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const provider = new ShellFailureRecoveryProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 4 });

    const result = await agent.run("Run tests, then recover.");

    expect(result.content).toBe("Recovered after shell failure.");
    expect(result.toolResults.map((entry) => entry.toolCall.name)).toEqual([
      "run_shell",
      "run_shell",
    ]);
  });

  it("limits repeated identical failing tool calls", async () => {
    const provider = new RepeatedFailureProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 5 });

    const result = await agent.run("Keep trying the same missing file.");

    expect(result.content).toBe("Stopped repeating identical tool calls.");
    expect(result.toolResults).toHaveLength(3);
    expect(result.toolResults.at(-1)?.result.ok).toBe(false);
    expect(result.toolResults.at(-1)?.result.content).toContain(
      "Retry chain limit reached",
    );
  });

  it("allows the same test command after successful file edits", async () => {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node test.mjs" } }, null, 2),
      "utf8",
    );
    await writeFile(
      join(workspace, "src-tasks.mjs"),
      [
        "export function normalizeTask(input) {",
        "  return { ...input, title: input.title };",
        "}",
        "",
        "export function filterOverdue(tasks, today = '2026-06-02') {",
        "  return tasks.filter((task) => task.due && task.due < today);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "test.mjs"),
      [
        "import assert from 'node:assert/strict';",
        "import { normalizeTask, filterOverdue } from './src-tasks.mjs';",
        "const tasks = [",
        "  normalizeTask({ id: 'a', title: ' Ship report ', status: 'todo', due: '2026-05-30' }),",
        "  normalizeTask({ id: 'b', title: 'Done report', status: 'done', due: '2026-05-29' }),",
        "];",
        "assert.equal(tasks[0].title, 'Ship report');",
        "assert.deepEqual(filterOverdue(tasks).map((task) => task.id), ['a']);",
        "console.log('TEST_PASS_AFTER_EDITS');",
        "",
      ].join("\n"),
      "utf8",
    );

    const provider = new TestCommandAfterEditsProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 8,
      permissionMode: "acceptEdits",
    });

    const result = await agent.run("Fix the project and rerun tests.");

    expect(result.content).toBe("Tests passed after edits.");
    expect(result.toolResults.map((entry) => entry.toolCall.name)).toEqual([
      "run_shell",
      "read_file",
      "edit_file",
      "run_shell",
      "edit_file",
      "run_shell",
    ]);
    expect(result.toolResults.at(-1)?.result.ok).toBe(true);
    expect(result.toolResults.at(-1)?.result.content).toContain(
      "TEST_PASS_AFTER_EDITS",
    );
  }, 15_000);
});

class MissingFileRecoveryProvider implements ModelProvider {
  readonly name = "missing-file-recovery";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return toolCall("read_file", { path: "src/ap.ts" });
    }

    const last = lastToolResult(input);
    if (this.calls === 2) {
      expect(last?.ok).toBe(false);
      if (last && !last.ok) {
        expect(last.error.code).toBe("FileNotFound");
        expect(last.content).toContain("list_files");
        expect(last.content).toContain("grep_search");
      }
      return toolCall("list_files", { path: "src" });
    }

    if (this.calls === 3) {
      expect(last?.ok).toBe(true);
      expect(last?.content).toContain("src/app.ts");
      return toolCall("read_file", { path: "src/app.ts" });
    }

    expect(last?.ok).toBe(true);
    expect(last?.content).toContain("export const app");
    return { content: "Recovered by reading src/app.ts.", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

class EditSearchRecoveryProvider implements ModelProvider {
  readonly name = "edit-search-recovery";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return toolCall("read_file", { path: "target.txt" });
    }

    const last = lastToolResult(input);
    if (this.calls === 2) {
      expect(last?.ok).toBe(true);
      return toolCall("edit_file", {
        path: "target.txt",
        oldString: "gamma",
        newString: "beta",
      });
    }

    if (this.calls === 3) {
      expect(last?.ok).toBe(false);
      if (last && !last.ok) {
        expect(last.error.code).toBe("SearchStringNotFound");
        expect(last.content).toContain("read_file");
        expect(last.content).toContain("exact substring");
      }
      return toolCall("read_file", { path: "target.txt" });
    }

    if (this.calls === 4) {
      expect(last?.ok).toBe(true);
      return toolCall("edit_file", {
        path: "target.txt",
        oldString: "alpha",
        newString: "beta",
      });
    }

    expect(last?.ok).toBe(true);
    return { content: "Edited after rereading.", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

class ShellFailureRecoveryProvider implements ModelProvider {
  readonly name = "shell-failure-recovery";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return toolCall("run_shell", { command: "npm test" });
    }

    const last = lastToolResult(input);
    if (this.calls === 2) {
      expect(last?.ok).toBe(false);
      if (last && !last.ok) {
        expect(last.error.code).toBe("CommandFailed");
        expect(last.content).toContain("Exit code:");
        expect(last.content).toContain("STDERR:");
        expect(last.content).toContain("adjust the command");
      }
      return toolCall("run_shell", { command: "node --version" });
    }

    expect(last?.ok).toBe(true);
    expect(last?.content).toMatch(/v\d+\.\d+\.\d+/);
    return { content: "Recovered after shell failure.", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

class RepeatedFailureProvider implements ModelProvider {
  readonly name = "repeated-failure";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const last = lastToolResult(input);
    if (last?.content.includes("Retry chain limit reached")) {
      return {
        content: "Stopped repeating identical tool calls.",
        toolCalls: [],
      };
    }

    return toolCall("read_file", { path: "missing.txt" });
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

class TestCommandAfterEditsProvider implements ModelProvider {
  readonly name = "test-command-after-edits";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const last = lastToolResult(input);

    if (this.calls === 1) {
      return toolCall("run_shell", { command: "npm test" });
    }

    if (this.calls === 2) {
      expect(last?.ok).toBe(false);
      return toolCall("read_file", { path: "src-tasks.mjs" });
    }

    if (this.calls === 3) {
      expect(last?.ok).toBe(true);
      return toolCall("edit_file", {
        path: "src-tasks.mjs",
        oldString: "title: input.title",
        newString: "title: input.title.trim()",
      });
    }

    if (this.calls === 4) {
      expect(last?.ok).toBe(true);
      return toolCall("run_shell", { command: "npm test" });
    }

    if (this.calls === 5) {
      expect(last?.ok).toBe(false);
      return toolCall("edit_file", {
        path: "src-tasks.mjs",
        oldString:
          "return tasks.filter((task) => task.due && task.due < today);",
        newString:
          "return tasks.filter((task) => task.due && task.due < today && task.status !== 'done');",
      });
    }

    if (this.calls === 6) {
      expect(last?.ok).toBe(true);
      return toolCall("run_shell", { command: "npm test" });
    }

    expect(last?.ok).toBe(true);
    expect(last?.content).not.toContain("Retry chain limit reached");
    expect(last?.content).toContain("TEST_PASS_AFTER_EDITS");
    return { content: "Tests passed after edits.", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

function toolCall(name: string, input: unknown): ModelResponse {
  return {
    content: "",
    toolCalls: [
      {
        id: `call_${name}_${Math.random().toString(16).slice(2)}`,
        name,
        input,
        rawArguments: JSON.stringify(input),
      },
    ],
  };
}

function lastToolResult(input: ModelRequest): ToolResult | undefined {
  const message = [...input.messages].reverse().find((entry) => entry.role === "tool");
  return message ? (JSON.parse(message.content) as ToolResult) : undefined;
}
