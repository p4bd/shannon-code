import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ModelMessage } from "../core/model-provider.js";
import {
  parseSessionJsonl,
  serializeSession,
  type SerializedSession,
  type SessionMetadata,
} from "./serializer.js";

export interface SessionSummary {
  sessionId: string;
  path: string;
  updatedAt: string;
  messageCount: number;
}

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(private readonly cwd: string) {
    this.sessionsDir = resolve(cwd, ".agent", "sessions");
  }

  createSessionId(): string {
    return randomUUID();
  }

  async saveSession(input: {
    sessionId: string;
    messages: ModelMessage[];
  }): Promise<SerializedSession> {
    await mkdir(this.sessionsDir, { recursive: true });
    const existing = await this.tryLoadSession(input.sessionId);
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      sessionId: input.sessionId,
      cwd: this.cwd,
      createdAt: existing?.metadata.createdAt ?? now,
      updatedAt: now,
    };
    const session = {
      metadata,
      messages: input.messages,
    };

    const sessionPath = this.getSessionPath(input.sessionId);
    const temporaryPath = `${sessionPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serializeSession(session), "utf8");
      await rename(temporaryPath, sessionPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    return session;
  }

  async loadSession(sessionId: string): Promise<SerializedSession> {
    const raw = await readFile(this.getSessionPath(sessionId), "utf8");
    return parseSessionJsonl(raw);
  }

  async tryLoadSession(
    sessionId: string,
  ): Promise<SerializedSession | undefined> {
    try {
      return await this.loadSession(sessionId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async loadLatestSession(): Promise<SerializedSession | undefined> {
    const latest = (await this.listSessions())[0];
    return latest ? this.loadSession(latest.sessionId) : undefined;
  }

  async listSessions(): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map(async (entry): Promise<SessionSummary | undefined> => {
          const path = resolve(this.sessionsDir, entry);
          try {
            const [fileStat, session] = await Promise.all([
              stat(path),
              readFile(path, "utf8").then(parseSessionJsonl),
            ]);

            return {
              sessionId: session.metadata.sessionId,
              path,
              updatedAt: session.metadata.updatedAt,
              messageCount: session.messages.length,
            };
          } catch {
            return {
              sessionId: basename(entry, ".jsonl"),
              path,
              updatedAt: fileStatFallbackDate(),
              messageCount: 0,
            };
          }
        }),
    );

    return summaries
      .filter((summary): summary is SessionSummary => Boolean(summary))
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      );
  }

  getSessionPath(sessionId: string): string {
    return resolve(this.sessionsDir, `${sessionId}.jsonl`);
  }
}

function fileStatFallbackDate(): string {
  return new Date(0).toISOString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
