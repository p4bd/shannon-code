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
import { LocalSubagentRunner } from "../../src/subagent/runner.js";

describe("sub-agent runner", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-subagent-runner-"));
    await writeFile(join(workspace, "package.json"), "{}", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lets the main agent delegate through the agent tool and returns a summary", async () => {
    const provider = new DelegatingProvider();
    const runner = new LocalSubagentRunner({
      provider,
      cwd: workspace,
      defaultMaxTurns: 2,
    });
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 3,
      subagentRunner: runner,
    });

    const result = await agent.run("Delegate exploration.");

    expect(result.content).toBe("Parent received sub-agent summary.");
    expect(result.toolResults[0]?.toolCall.name).toBe("agent");
    expect(result.toolResults[0]?.result.ok).toBe(true);
    expect(result.toolResults[0]?.result.content).toContain("Sub-agent explore completed");
    expect(provider.childToolNames).toEqual(["read_file", "list_files", "grep_search"]);
  });

  it("enforces recursion depth limits", async () => {
    const provider = new FinalProvider();
    const runner = new LocalSubagentRunner({
      provider,
      cwd: workspace,
      maxDepth: 1,
    });

    const result = await runner.run({
      agentType: "explore",
      prompt: "inspect",
      parentSessionId: "parent",
      depth: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PermissionDenied");
      expect(result.content).toContain("depth limit");
    }
  });

  it("runs custom agents with configured tool allowlists", async () => {
    await mkdir(join(workspace, ".agent", "agents"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review code\nallowed_tools: [read_file]\npermission_mode: plan\n---\nReview only with read_file.",
      "utf8",
    );

    const provider = new CustomAgentProvider();
    const runner = new LocalSubagentRunner({
      provider,
      cwd: workspace,
      defaultMaxTurns: 1,
    });

    const result = await runner.run({
      agentType: "reviewer",
      prompt: "review package",
      parentSessionId: "parent",
      depth: 0,
    });

    expect(result.ok).toBe(true);
    expect(provider.toolNames).toEqual(["read_file"]);
  });
});

class DelegatingProvider implements ModelProvider {
  readonly name = "delegating";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];
  childToolNames: string[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    const lastUser = [...input.messages].reverse().find((message) => message.role === "user");

    if (lastUser?.content.includes("explore sub-agent")) {
      this.childToolNames = input.tools?.map((tool) => tool.name) ?? [];
      return {
        content: "Found package.json.",
        toolCalls: [],
      };
    }

    if (!input.messages.some((message) => message.role === "tool")) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_agent",
            name: "agent",
            input: { agentType: "explore", prompt: "Find package files" },
            rawArguments: JSON.stringify({
              agentType: "explore",
              prompt: "Find package files",
            }),
          },
        ],
      };
    }

    return {
      content: "Parent received sub-agent summary.",
      toolCalls: [],
    };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

class FinalProvider implements ModelProvider {
  readonly name = "final";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;

  async createMessage(): Promise<ModelResponse> {
    return { content: "done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

class CustomAgentProvider implements ModelProvider {
  readonly name = "custom-agent";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  toolNames: string[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.toolNames = input.tools?.map((tool) => tool.name) ?? [];
    return { content: "reviewed", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}
