import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../../src/core/agent.js";
import { ProviderError } from "../../src/core/errors.js";
import { MemoryStore } from "../../src/memory/store.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ok } from "../../src/tools/result.js";
import type { Tool } from "../../src/tools/types.js";

describe("Agent tool loop", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-agent-loop-"));
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "fixture-app" }, null, 2),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("executes a model-requested tool and sends the result back", async () => {
    const provider = new MockToolCallingProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 3 });

    const result = await agent.run("Read package.json and summarize it.");

    expect(result.content).toBe("The package is fixture-app.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolCall.name).toBe("read_file");
    expect(result.toolResults[0]?.result.ok).toBe(true);
    expect(provider.requests[0]?.tools?.some((tool) => tool.name === "read_file")).toBe(
      true,
    );
    expect(
      provider.requests[1]?.messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("fixture-app"),
      ),
    ).toBe(true);
  });

  it("preserves messages across multiple runs", async () => {
    const provider = new EchoRequestCountProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 2 });

    await agent.run("first");
    await agent.run("second");

    expect(provider.requests).toHaveLength(2);
    expect(
      provider.requests[1]?.messages.some(
        (message) => message.role === "user" && message.content === "first",
      ),
    ).toBe(true);
    expect(
      provider.requests[1]?.messages.some(
        (message) => message.role === "assistant" && message.content === "reply 1",
      ),
    ).toBe(true);
  });

  it("stops when maxTurns is reached", async () => {
    const provider = new AlwaysToolProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 1 });

    const result = await agent.run("keep using tools");

    expect(result.stoppedByMaxTurns).toBe(true);
    expect(result.content).toContain("Stopped after 1 turns");
    expect(result.toolResults).toHaveLength(1);
  });

  it("streams text and tool events through the event callback", async () => {
    const provider = new StreamingToolProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 3 });
    const events: AgentEvent[] = [];

    const result = await agent.run("stream and read", {
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe("Done.");
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(["I will read. ", "Done."]);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("does not execute tool calls from a length-truncated response", async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      ...createDelayedReadTool("dangerous_tool", () => {}, () => {}),
      async execute() {
        executed = true;
        return ok("should not run");
      },
    });
    const provider = new TruncatedToolProvider();
    const agent = new Agent({ provider, registry, cwd: workspace, maxTurns: 2 });

    const result = await agent.run("do it");

    expect(executed).toBe(false);
    expect(result.content).toBe("recovered");
    expect(result.toolResults[0]?.result.ok).toBe(false);
    expect(
      provider.requests[1]?.messages.find((message) => message.role === "tool")
        ?.content,
    ).toContain("TruncatedToolCall");
  });

  it("passes cancellation to the provider", async () => {
    const provider = new AbortingProvider();
    const agent = new Agent({ provider, cwd: workspace });
    const controller = new AbortController();
    const running = agent.run("wait", { signal: controller.signal });

    await provider.started;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.signal).toBe(controller.signal);
  });

  it("runs consecutive read-only concurrency-safe tools in parallel", async () => {
    let active = 0;
    let maxActive = 0;
    const registry = new ToolRegistry();
    registry.register(createDelayedReadTool("slow_read_a", () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    }, () => {
      active -= 1;
    }));
    registry.register(createDelayedReadTool("slow_read_b", () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    }, () => {
      active -= 1;
    }));

    const provider = new MultiToolProvider(["slow_read_a", "slow_read_b"]);
    const agent = new Agent({ provider, registry, cwd: workspace, maxTurns: 2 });

    const result = await agent.run("run both tools");

    expect(result.toolResults.map((entry) => entry.toolCall.name)).toEqual([
      "slow_read_a",
      "slow_read_b",
    ]);
    expect(maxActive).toBe(2);
  });

  it("auto-compacts before model requests when context exceeds budget", async () => {
    const provider = new EchoRequestCountProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 1,
      initialMessages: createLongHistory(8),
      contextBudget: {
        maxEstimatedTokens: 20,
        autoCompactThreshold: 0.5,
        recentMessages: 2,
      },
    });

    await agent.run("current task");

    expect(provider.requests[0]?.messages[1]?.content).toContain(
      "Conversation summary",
    );
    expect(provider.requests[0]?.messages.length).toBeLessThan(8);
  });

  it("compacts and retries once after prompt-too-long provider errors", async () => {
    const provider = new PromptTooLongOnceProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 1,
      initialMessages: createLongHistory(8),
      contextBudget: {
        maxEstimatedTokens: 100_000,
        autoCompactThreshold: 1,
        recentMessages: 2,
      },
    });

    const result = await agent.run("current task");

    expect(result.content).toBe("recovered");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages[1]?.content).toContain(
      "Conversation summary",
    );
  });

  it("injects project rules and recalled memories into the system prompt", async () => {
    const memoryStore = new MemoryStore(workspace);
    await memoryStore.add("Prefer vitest when adding tests.");
    const provider = new RuleAndMemoryProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 1,
      projectRules: {
        sections: [
          {
            source: "AGENTS.md",
            content: "Always mention edited files.",
          },
        ],
        content: "## AGENTS.md\nAlways mention edited files.",
      },
      memoryStore,
    });

    await agent.run("How should I add tests?");

    const mainRequest = provider.requests[1];
    expect(mainRequest?.messages[0]?.content).toContain("Project rules:");
    expect(mainRequest?.messages[0]?.content).toContain(
      "Always mention edited files.",
    );
    expect(mainRequest?.messages[0]?.content).toContain("Relevant memory:");
    expect(mainRequest?.messages[0]?.content).toContain(
      "Prefer vitest when adding tests.",
    );
  });

  it("blocks normal file writes while agent is in plan mode", async () => {
    const provider = new PlanModeWriteProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 2,
      permissionMode: "plan",
    });

    const result = await agent.run("try to write a file");

    expect(result.toolResults[0]?.toolCall.name).toBe("write_file");
    expect(result.toolResults[0]?.result.ok).toBe(false);
    if (result.toolResults[0] && !result.toolResults[0].result.ok) {
      expect(result.toolResults[0].result.error.code).toBe("PermissionDenied");
    }
  });
});

class MockToolCallingProvider implements ModelProvider {
  readonly name = "mock";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);

    if (this.requests.length === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_read_package",
            name: "read_file",
            input: { path: "package.json" },
            rawArguments: JSON.stringify({ path: "package.json" }),
          },
        ],
      };
    }

    return {
      content: "The package is fixture-app.",
      toolCalls: [],
    };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: {
        content: "The package is fixture-app.",
        toolCalls: [],
      },
    };
  }
}

class EchoRequestCountProvider implements ModelProvider {
  readonly name = "echo";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    return {
      content: `reply ${this.requests.length}`,
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

class AlwaysToolProvider implements ModelProvider {
  readonly name = "always-tool";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;

  async createMessage(): Promise<ModelResponse> {
    return {
      content: "",
      toolCalls: [
        {
          id: "call_read_package",
          name: "read_file",
          input: { path: "package.json" },
          rawArguments: JSON.stringify({ path: "package.json" }),
        },
      ],
    };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

class StreamingToolProvider implements ModelProvider {
  readonly name = "streaming-tool";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = true;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(): Promise<ModelResponse> {
    throw new Error("createMessage should not be used when streaming is enabled");
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text_delta", delta: "I will read. " };
      yield {
        type: "done",
        response: {
          content: "I will read. ",
          toolCalls: [
            {
              id: "call_read_package",
              name: "read_file",
              input: { path: "package.json" },
              rawArguments: JSON.stringify({ path: "package.json" }),
            },
          ],
        },
      };
      return;
    }

    yield { type: "text_delta", delta: "Done." };
    yield {
      type: "done",
      response: { content: "Done.", toolCalls: [] },
    };
  }
}

class MultiToolProvider implements ModelProvider {
  readonly name = "multi-tool";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  constructor(private readonly toolNames: string[]) {}

  async createMessage(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        toolCalls: this.toolNames.map((name, index) => ({
          id: `call_${name}`,
          name,
          input: { label: name },
          rawArguments: JSON.stringify({ label: name, index }),
        })),
      };
    }

    return { content: "done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

class TruncatedToolProvider implements ModelProvider {
  readonly name = "truncated-tool";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    if (this.requests.length > 1) return { content: "recovered", toolCalls: [] };
    return {
      content: "",
      stopReason: "length",
      toolCalls: [{
        id: "truncated",
        name: "dangerous_tool",
        input: { label: "partial" },
        rawArguments: '{"label":"partial',
      }],
    };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

class AbortingProvider implements ModelProvider {
  readonly name = "aborting";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  signal?: AbortSignal;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.signal = input.signal;
    this.markStarted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(input.signal?.reason);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
    return { content: "unused", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

function createDelayedReadTool(
  name: string,
  onStart: () => void,
  onFinish: () => void,
): Tool<{ label: string }> {
  return {
    name,
    description: `Delayed read tool ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
      },
      required: ["label"],
      additionalProperties: false,
    },
    safety: "read",
    readOnly: true,
    concurrencySafe: true,
    requiresApproval: false,
    enabledInPlanMode: true,
    async execute(input) {
      onStart();
      await new Promise((resolve) => setTimeout(resolve, 20));
      onFinish();
      return ok(`read ${input.label}`);
    },
  };
}

class PromptTooLongOnceProvider implements ModelProvider {
  readonly name = "prompt-too-long-once";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    if (this.requests.length === 1) {
      throw new ProviderError("Model provider request failed: prompt is too long");
    }

    return { content: "recovered", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

class RuleAndMemoryProvider implements ModelProvider {
  readonly name = "rule-memory";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    if (this.requests.length === 1) {
      const parsed = JSON.parse(input.messages[1]?.content ?? "{}") as {
        memories?: Array<{ id: string }>;
      };
      return {
        content: JSON.stringify([parsed.memories?.[0]?.id].filter(Boolean)),
        toolCalls: [],
      };
    }

    return {
      content: "Use vitest.",
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

class PlanModeWriteProvider implements ModelProvider {
  readonly name = "plan-mode-write";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_write",
            name: "write_file",
            input: { path: "src/unsafe.ts", content: "export {};\n" },
            rawArguments: JSON.stringify({
              path: "src/unsafe.ts",
              content: "export {};\n",
            }),
          },
        ],
      };
    }

    return { content: "blocked", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

function createLongHistory(count: number) {
  return [
    { role: "system" as const, content: "system" },
    ...Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `old message ${index} ${"x".repeat(80)}`,
    })),
  ];
}
