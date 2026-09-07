import type { ModelMessage } from "../core/model-provider.js";

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionRecord =
  | {
      type: "metadata";
      metadata: SessionMetadata;
    }
  | {
      type: "message";
      message: ModelMessage;
    };

export interface SerializedSession {
  metadata: SessionMetadata;
  messages: ModelMessage[];
}

export function serializeSession(session: SerializedSession): string {
  const records: SessionRecord[] = [
    { type: "metadata", metadata: session.metadata },
    ...session.messages.map((message) => ({
      type: "message" as const,
      message,
    })),
  ];

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function parseSessionJsonl(raw: string): SerializedSession {
  const records = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionRecord);

  const metadata = records.find(
    (record): record is Extract<SessionRecord, { type: "metadata" }> =>
      record.type === "metadata",
  )?.metadata;

  if (!metadata) {
    throw new Error("Session JSONL is missing metadata.");
  }

  return {
    metadata,
    messages: records.flatMap((record) =>
      record.type === "message" ? [record.message] : [],
    ),
  };
}
