import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("long task stability", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-long-task-"));
    await writeFile(join(workspace, "target.txt"), "stable content\n", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("keeps a long tool loop stable without dropping tool results", async () => {
    const provider = new LongReadLoopProvider(16);
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 20 });

    const result = await agent.run("Repeatedly inspect target.txt before answering.");

    expect(result.stoppedByMaxTurns).toBe(false);
    expect(result.content).toBe("Completed 16 reads.");
    expect(result.toolResults).toHaveLength(16);
    expect(result.toolResults.every((entry) => entry.result.ok)).toBe(true);
    expect(provider.requests).toHaveLength(17);
    expect(provider.requests.at(-1)?.messages.filter((message) => message.role === "tool")).toHaveLength(16);
  });
});

class LongReadLoopProvider implements ModelProvider {
  readonly name = "long-read-loop";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly iterations: number) {}

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    if (this.requests.length <= this.iterations) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_read_${this.requests.length}`,
            name: "read_file",
            input: { path: "target.txt" },
            rawArguments: JSON.stringify({ path: "target.txt" }),
          },
        ],
      };
    }

    return {
      content: `Completed ${this.iterations} reads.`,
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
