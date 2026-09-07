import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session/store.js";

describe("SessionStore", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-session-store-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("saves, loads, and lists sessions", async () => {
    const store = new SessionStore(workspace);
    await store.saveSession({
      sessionId: "session-a",
      messages: [{ role: "system", content: "system" }],
    });
    await store.saveSession({
      sessionId: "session-b",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
    });

    await expect(store.loadSession("session-b")).resolves.toMatchObject({
      metadata: { sessionId: "session-b" },
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
    });

    const sessions = await store.listSessions();
    expect(sessions.map((session) => session.sessionId)).toContain("session-a");
    expect(sessions.map((session) => session.sessionId)).toContain("session-b");
    await expect(store.loadLatestSession()).resolves.toBeDefined();
    expect(
      (await readdir(join(workspace, ".agent", "sessions"))).some((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toBe(false);
  });
});
