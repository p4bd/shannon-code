import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface MemoryItem {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  private readonly memoryFile: string;

  constructor(private readonly cwd: string) {
    this.memoryFile = resolve(cwd, ".agent", "memory", "memories.jsonl");
  }

  async add(content: string): Promise<MemoryItem> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("Memory content cannot be empty.");
    }

    const now = new Date().toISOString();
    const item: MemoryItem = {
      id: randomUUID(),
      content: trimmed,
      createdAt: now,
      updatedAt: now,
    };
    const memories = await this.list();
    memories.push(item);
    await this.writeAll(memories);
    return item;
  }

  async list(): Promise<MemoryItem[]> {
    let raw: string;
    try {
      raw = await readFile(this.memoryFile, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as MemoryItem);
  }

  async delete(idPrefix: string): Promise<MemoryItem | undefined> {
    const memories = await this.list();
    const matches = memories.filter((item) => item.id.startsWith(idPrefix));
    if (matches.length !== 1) {
      return undefined;
    }

    await this.writeAll(memories.filter((item) => item.id !== matches[0]!.id));
    return matches[0];
  }

  async writeAll(memories: MemoryItem[]): Promise<void> {
    await mkdir(resolve(this.cwd, ".agent", "memory"), { recursive: true });
    const content =
      memories.map((memory) => JSON.stringify(memory)).join("\n") +
      (memories.length > 0 ? "\n" : "");
    await writeFile(this.memoryFile, content, "utf8");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
