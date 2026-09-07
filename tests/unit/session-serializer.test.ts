import { describe, expect, it } from "vitest";
import {
  parseSessionJsonl,
  serializeSession,
} from "../../src/session/serializer.js";

describe("session serializer", () => {
  it("round trips JSONL sessions", () => {
    const session = {
      metadata: {
        sessionId: "session-1",
        cwd: "E:/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      messages: [
        { role: "system" as const, content: "system prompt" },
        { role: "user" as const, content: "hello" },
      ],
    };

    expect(parseSessionJsonl(serializeSession(session))).toEqual(session);
  });
});
