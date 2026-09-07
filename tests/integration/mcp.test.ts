import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { McpManager, loadMcpConfig } from "../../src/mcp/manager.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("MCP stdio integration", () => {
  let workspace: string;
  let manager: McpManager | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-mcp-"));
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "mcp.json"),
      JSON.stringify({
        servers: {
          test: {
            command: process.execPath,
            args: [join(process.cwd(), "tests", "fixtures", "mcp-test-server.mjs")],
          },
        },
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await manager?.stopAll();
    await rm(workspace, { recursive: true, force: true });
  });

  it("loads MCP config", async () => {
    await expect(loadMcpConfig(workspace)).resolves.toMatchObject({
      servers: {
        test: {
          command: process.execPath,
        },
      },
    });
  });

  it("registers and calls MCP tools through the internal registry", async () => {
    const registry = new ToolRegistry();
    manager = await McpManager.load(workspace, new NoopLogger());
    await manager?.registerTools(registry);

    expect(registry.list().map((tool) => tool.name)).toEqual([
      "mcp__test__add",
      "mcp__test__echo",
      "mcp__test__fail",
      "mcp__test__slow",
    ]);

    const result = await registry.execute(
      "mcp__test__add",
      { a: 2, b: 5 },
      createContext(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("7");
  });

  it("returns McpError for MCP tool failures", async () => {
    const registry = new ToolRegistry();
    manager = await McpManager.load(workspace, new NoopLogger());
    await manager?.registerTools(registry);

    const result = await registry.execute("mcp__test__fail", {}, createContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("McpError");
      expect(result.content).toContain("Tool failed intentionally");
    }
  });

  it("aborts an in-flight MCP tool call", async () => {
    const registry = new ToolRegistry();
    manager = await McpManager.load(workspace, new NoopLogger());
    await manager?.registerTools(registry);
    const controller = new AbortController();
    const running = registry.execute(
      "mcp__test__slow",
      {},
      { ...createContext(), abortSignal: controller.signal },
    );

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  function createContext() {
    return {
      cwd: workspace,
      sessionId: "test-session",
      permissionMode: "bypassPermissions" as const,
      subagentDepth: 0,
      readTracker: new InMemoryReadTracker(),
      artifactStore: new PassthroughLargeResultStore(),
      logger: new NoopLogger(),
    };
  }
});
