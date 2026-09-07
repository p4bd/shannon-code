import type { ModelProvider } from "../core/model-provider.js";
import type { MemoryItem, MemoryStore } from "./store.js";

export interface MemoryRecallOptions {
  limit?: number;
  provider?: ModelProvider;
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 5;

export async function recallMemories(
  store: MemoryStore,
  query: string,
  options: MemoryRecallOptions = {},
): Promise<MemoryItem[]> {
  const memories = await store.list();
  if (memories.length === 0) {
    return [];
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  if (options.provider) {
    const selected = await recallWithModel({
      provider: options.provider,
      memories,
      query,
      limit,
      signal: options.signal,
    });
    if (selected.length > 0) {
      return selected;
    }
  }

  return recallWithKeywordScore(memories, query, limit);
}

async function recallWithModel(input: {
  provider: ModelProvider;
  memories: MemoryItem[];
  query: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<MemoryItem[]> {
  try {
    const response = await input.provider.createMessage({
      messages: [
        {
          role: "system",
          content:
            "Select relevant memory ids for the user query. Return only a JSON array of ids.",
        },
        {
          role: "user",
          content: JSON.stringify({
            query: input.query,
            memories: input.memories.map((memory) => ({
              id: memory.id,
              content: memory.content,
            })),
            limit: input.limit,
          }),
        },
      ],
      signal: input.signal,
    });
    const ids = parseIdArray(response.content).slice(0, input.limit);
    const byId = new Map(input.memories.map((memory) => [memory.id, memory]));
    return ids.flatMap((id) => {
      const exact = byId.get(id);
      if (exact) {
        return [exact];
      }

      const prefixMatch = input.memories.find((memory) =>
        memory.id.startsWith(id),
      );
      return prefixMatch ? [prefixMatch] : [];
    });
  } catch {
    input.signal?.throwIfAborted();
    return [];
  }
}

export function recallWithKeywordScore(
  memories: MemoryItem[],
  query: string,
  limit = DEFAULT_LIMIT,
): MemoryItem[] {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return memories.slice(-limit);
  }

  return memories
    .map((memory) => ({
      memory,
      score: scoreMemory(memory, queryTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.memory);
}

function scoreMemory(memory: MemoryItem, queryTokens: Set<string>): number {
  const memoryTokens = tokenize(memory.content);
  let score = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) {
      score += token.length > 3 ? 2 : 1;
    }
  }

  return score;
}

function parseIdArray(content: string): string[] {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(jsonMatch?.[0] ?? trimmed) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string")
    : [];
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}
