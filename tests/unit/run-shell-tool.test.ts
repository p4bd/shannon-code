import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import {
  FileLargeResultStore,
  PassthroughLargeResultStore,
} from "../../src/context/large-result-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runShellTool } from "../../src/tools/run-shell.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("run_shell tool", () => {
  it("runs a safe command and captures stdout", async () => {
    const result = await runShellTool.execute(
      { command: "node --version" },
      createContext("default"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Exit code: 0");
    expect(result.content).toMatch(/v\d+\.\d+\.\d+/);
  });

  it("stores large shell output as an artifact instead of returning it inline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "shannon-shell-output-"));
    try {
      const result = await runShellTool.execute(
        {
          command: "node -e \"process.stdout.write('x'.repeat(100))\"",
        },
        {
          ...createContext("default"),
          cwd: workspace,
          artifactStore: new FileLargeResultStore(workspace, {
            thresholdBytes: 40,
            previewBytes: 20,
          }),
        },
      );

      expect(result.ok).toBe(true);
      expect(result.content).toContain("Tool result was too large");
      expect(result.content.length).toBeLessThan(220);
      expect(result.metadata?.stored).toBe(true);
      const artifactPath = join(
        workspace,
        String(result.metadata?.artifactPath).replaceAll("/", "\\"),
      );
      expect(await readFile(artifactPath, "utf8")).toContain("x".repeat(100));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("aborts a running command", async () => {
    const controller = new AbortController();
    const running = runShellTool.execute(
      { command: "node -e \"setTimeout(() => {}, 10000)\"" },
      { ...createContext("default"), abortSignal: controller.signal },
    );

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  const itOnWindows = process.platform === "win32" ? it : it.skip;
  itOnWindows("decodes legacy Windows shell output without mojibake", async () => {
    const result = await runShellTool.execute(
      {
        command:
          'node -e "process.stdout.write(Buffer.from([0xb2,0xe2,0xca,0xd4]))"',
      },
      createContext("default"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("测试");
  });

  it("is blocked by the registry in dontAsk mode because it requires approval", async () => {
    const registry = new ToolRegistry();
    registry.register(runShellTool);

    const result = await registry.execute(
      "run_shell",
      { command: "node --version" },
      createContext("dontAsk"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PermissionDenied");
    }
  });
});

function createContext(permissionMode: "default" | "dontAsk") {
  return {
    cwd: process.cwd(),
    sessionId: "test-session",
    permissionMode,
    readTracker: new InMemoryReadTracker(),
    artifactStore: new PassthroughLargeResultStore(),
    logger: new NoopLogger(),
  };
}
