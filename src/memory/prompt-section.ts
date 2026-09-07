import type { MemoryItem } from "./store.js";

export function formatMemoryPromptSection(memories: MemoryItem[]): string {
  return memories
    .map((memory) => `- (${memory.id.slice(0, 8)}) ${memory.content}`)
    .join("\n");
}
