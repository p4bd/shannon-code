import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recallMemories, recallWithKeywordScore } from "../../src/memory/recall.js";
import { MemoryStore, type MemoryItem } from "../../src/memory/store.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";

describe("memory", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-memory-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("adds, lists, and deletes project memories", async () => {
    const store = new MemoryStore(workspace);
    const first = await store.add("Prefer vitest for unit tests.");
    await store.add("Use concise CLI output.");

    expect(await store.list()).toHaveLength(2);
    expect(await store.delete(first.id.slice(0, 8))).toMatchObject({
      content: "Prefer vitest for unit tests.",
    });
    expect(await store.list()).toHaveLength(1);
  });

  it("recalls memories with keyword fallback", () => {
    const memories: MemoryItem[] = [
      createMemory("a", "Prefer vitest for TypeScript tests."),
      createMemory("b", "Use short replies in Chinese."),
    ];

    expect(recallWithKeywordScore(memories, "How should tests be written?")).toEqual([
      memories[0],
    ]);
  });

  it("uses model-selected memory ids when available", async () => {
    const store = new MemoryStore(workspace);
    const first = await store.add("Use pnpm for package installs.");
    const second = await store.add("Prefer vitest for tests.");
    const provider = new MemorySelectorProvider(second.id);

    await expect(
      recallMemories(store, "test framework", { provider }),
    ).resolves.toEqual([second]);
    expect(provider.requests).toHaveLength(1);
    expect(first.id).not.toBe(second.id);
  });
});

function createMemory(id: string, content: string): MemoryItem {
  return {
    id,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

class MemorySelectorProvider implements ModelProvider {
  readonly name = "memory-selector";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly selectedId: string) {}

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    return {
      content: JSON.stringify([this.selectedId]),
      toolCalls: [],
    };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "[]", toolCalls: [] },
    };
  }
}
