import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { Agent } from "../../src/core/agent.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";
import { HookRunner } from "../../src/hooks/runner.js";
import { editFileTool } from "../../src/tools/edit-file.tool.js";
import { readFileTool } from "../../src/tools/read-file.tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runShellTool } from "../../src/tools/run-shell.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

const hookFixture = fileURLToPath(
  new URL("../fixtures/hook-fixture.mjs", import.meta.url),
);

let workspace: string;

describe("hook runner integration", () => {
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-hooks-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lets a PreToolUse hook deny run_shell", async () => {
    const registry = new ToolRegistry();
    registry.register(runShellTool);
    const result = await registry.execute(
      "run_shell",
      { command: "node --version" },
      createContext({
        hookRunner: createHookRunner("PreToolUse", "run_shell", "deny-run-shell"),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HookDenied");
      expect(result.content).toContain("run_shell is blocked by hook");
    }
  });

  it("lets a PreToolUse hook modify tool input before validation and execution", async () => {
    await writeFile(join(workspace, "original.txt"), "original", "utf8");
    await writeFile(join(workspace, "modified.txt"), "modified", "utf8");
    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const result = await registry.execute(
      "read_file",
      { path: "original.txt" },
      createContext({
        hookRunner: createHookRunner("PreToolUse", "read_file", "modify-read-target"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("modified");
    expect(result.content).not.toContain("original");
  });

  it("lets a PostToolUse hook run npm test after edit_file and append the result", async () => {
    await writeFile(join(workspace, "target.txt"), "before\n", "utf8");
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node test-ok.mjs" } }, null, 2),
      "utf8",
    );
    await writeFile(join(workspace, "test-ok.mjs"), "process.exit(0);\n", "utf8");

    const readTracker = new InMemoryReadTracker();
    const context = createContext({
      permissionMode: "acceptEdits",
      readTracker,
      hookRunner: createHookRunner("PostToolUse", "edit_file", "post-npm-test"),
    });
    await readFileTool.execute({ path: "target.txt" }, context);

    const registry = new ToolRegistry();
    registry.register(editFileTool);
    const result = await registry.execute(
      "edit_file",
      { path: "target.txt", oldString: "before", newString: "after" },
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("npm test passed");
  });

  it("isolates hook crashes from tool execution", async () => {
    await writeFile(join(workspace, "file.txt"), "content", "utf8");
    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const result = await registry.execute(
      "read_file",
      { path: "file.txt" },
      createContext({
        hookRunner: createHookRunner("PreToolUse", "read_file", "crash"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("content");
  });

  it("appends OnAgentFinish hook messages to final answers", async () => {
    const agent = new Agent({
      provider: new FinalProvider(),
      cwd: workspace,
      maxTurns: 1,
      hookRunner: createHookRunner("OnAgentFinish", "*", "append"),
    });

    const result = await agent.run("finish");

    expect(result.content).toContain("done");
    expect(result.content).toContain("hook appended for OnAgentFinish");
    expect(result.messages.at(-1)?.content).toContain(
      "hook appended for OnAgentFinish",
    );
  });
});

function createHookRunner(
  event: "PreToolUse" | "PostToolUse" | "OnAgentFinish",
  matcher: string,
  mode: string,
) {
  return new HookRunner(
    {
      hooks: [
        {
          event,
          matcher,
          command: process.execPath,
          args: [hookFixture, mode],
          timeoutMs: 10_000,
        },
      ],
    },
    new NoopLogger(),
  );
}

function createContext(input: {
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  readTracker?: InMemoryReadTracker;
  hookRunner?: HookRunner;
}) {
  return {
    cwd: workspace,
    sessionId: "test-session",
    permissionMode: input.permissionMode ?? ("default" as const),
    subagentDepth: 0,
    readTracker: input.readTracker ?? new InMemoryReadTracker(),
    artifactStore: new PassthroughLargeResultStore(),
    hookRunner: input.hookRunner,
    logger: new NoopLogger(),
  };
}

class FinalProvider implements ModelProvider {
  readonly name = "final";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    expect(input.messages.at(-1)?.content).toBe("finish");
    return { content: "done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}
