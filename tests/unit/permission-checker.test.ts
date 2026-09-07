import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { checkToolPermission } from "../../src/permissions/checker.js";
import type { PermissionMode } from "../../src/permissions/modes.js";
import { runShellTool } from "../../src/tools/run-shell.tool.js";
import { writeFileTool } from "../../src/tools/write-file.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("checkToolPermission", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-permissions-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("allows safe shell commands in default mode", async () => {
    const decision = await checkToolPermission({
      tool: runShellTool,
      toolInput: { command: "npm --version" },
      ctx: createContext("default"),
    });

    expect(decision.allowed).toBe(true);
  });

  it("blocks dangerous shell commands in default mode", async () => {
    const decision = await checkToolPermission({
      tool: runShellTool,
      toolInput: { command: "rm -rf dist" },
      ctx: createContext("default"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("DangerousCommand");
    }
  });

  it("allows dangerous shell commands in bypassPermissions mode", async () => {
    const decision = await checkToolPermission({
      tool: runShellTool,
      toolInput: { command: "rm -rf dist" },
      ctx: createContext("bypassPermissions"),
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.risk).toContain("Dangerous shell command");
    }
  });

  it("allows file writes in acceptEdits mode", async () => {
    const decision = await checkToolPermission({
      tool: writeFileTool,
      toolInput: { path: "src/a.ts", content: "" },
      ctx: createContext("acceptEdits"),
    });

    expect(decision.allowed).toBe(true);
  });

  it("asks for approval for file writes in default mode", async () => {
    const approvals: unknown[] = [];
    const decision = await checkToolPermission({
      tool: writeFileTool,
      toolInput: { path: "src/a.ts", content: "" },
      ctx: {
        ...createContext("default"),
        approvalPrompt: async (request) => {
          approvals.push(request);
          return true;
        },
      },
    });

    expect(decision.allowed).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      toolName: "write_file",
      subject: "src/a.ts",
    });
  });

  it("returns a recoverable denial when the user rejects approval", async () => {
    const decision = await checkToolPermission({
      tool: writeFileTool,
      toolInput: { path: "src/a.ts", content: "" },
      ctx: {
        ...createContext("default"),
        approvalPrompt: async () => false,
      },
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("PermissionDenied");
      expect(decision.content).toContain("denied by the user");
    }
  });

  it("blocks file writes in plan mode", async () => {
    const decision = await checkToolPermission({
      tool: writeFileTool,
      toolInput: { path: "src/a.ts", content: "" },
      ctx: createContext("plan"),
    });

    expect(decision.allowed).toBe(false);
  });

  it("allows writing tracked plan files in plan mode", async () => {
    const decision = await checkToolPermission({
      tool: writeFileTool,
      toolInput: { path: ".agent/plans/example.md", content: "# Plan" },
      ctx: createContext("plan"),
    });

    expect(decision.allowed).toBe(true);
  });

  it("applies deny rules before allow rules", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["run_shell:*"],
          deny: ["run_shell:git reset --hard"],
        },
      }),
      "utf8",
    );

    const decision = await checkToolPermission({
      tool: runShellTool,
      toolInput: { command: "git reset --hard" },
      ctx: createContext("default"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("PermissionDenied");
    }
  });

  it("allows commands matched by settings allow rules", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["run_shell:node scripts/migrate.js"],
          deny: [],
        },
      }),
      "utf8",
    );

    const decision = await checkToolPermission({
      tool: runShellTool,
      toolInput: { command: "node scripts/migrate.js" },
      ctx: createContext("default"),
    });

    expect(decision.allowed).toBe(true);
  });

  it("returns a structured denial for invalid settings JSON", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(join(workspace, ".agent", "settings.json"), "{", "utf8");

    const decision = await checkToolPermission({
      tool: runShellTool,
      toolInput: { command: "npm --version" },
      ctx: createContext("default"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("PermissionDenied");
      expect(decision.content).toContain("settings.json");
    }
  });

  function createContext(permissionMode: PermissionMode) {
    return {
      cwd: workspace,
      sessionId: "test-session",
      permissionMode,
      readTracker: new InMemoryReadTracker(),
      artifactStore: new PassthroughLargeResultStore(),
      logger: new NoopLogger(),
    };
  }
});
