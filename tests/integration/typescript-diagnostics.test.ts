import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { InMemoryReadTracker } from "../../src/context/read-tracker.js";
import { Agent } from "../../src/core/agent.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";
import { TypeScriptDiagnosticsRunner } from "../../src/lsp/typescript-diagnostics.js";
import { editFileTool } from "../../src/tools/edit-file.tool.js";
import { readFileTool } from "../../src/tools/read-file.tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { writeFileTool } from "../../src/tools/write-file.tool.js";
import { NoopLogger } from "../../src/utils/logger.js";

const tscFixture = fileURLToPath(
  new URL("../fixtures/tsc-diagnostics-fixture.mjs", import.meta.url),
);

describe("TypeScript diagnostics integration", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-ts-diagnostics-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("appends diagnostics after edit_file changes a TypeScript file", async () => {
    await createTsProject(workspace);
    await writeFile(
      join(workspace, "src", "index.ts"),
      "export const value: number = 1;\n",
      "utf8",
    );

    const registry = new ToolRegistry();
    registry.register(editFileTool);
    const ctx = createContext(workspace);
    await readFileTool.execute({ path: "src/index.ts" }, ctx);

    const result = await registry.execute(
      "edit_file",
      {
        path: "src/index.ts",
        oldString: "1",
        newString: '"bad"',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("TypeScript diagnostics:");
    expect(result.content).toContain("TS2322");
    expect(result.metadata?.typescriptDiagnostics).toMatchObject({
      status: "diagnostics",
    });
  });

  it("lets the agent see diagnostics and continue with a fix", async () => {
    await createTsProject(workspace);
    const provider = new DiagnosticsRepairProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 4,
      permissionMode: "acceptEdits",
      diagnosticsRunner: createDiagnosticsRunner(),
    });

    const result = await agent.run("Introduce then fix a type error.");

    expect(result.content).toBe("Fixed after diagnostics.");
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0]?.result.content).toContain("TS2322");
    expect(result.toolResults[1]?.result.content).toContain("No issues found.");
    expect(await readFile(join(workspace, "src", "index.ts"), "utf8")).toContain(
      "= 1",
    );
  });

  it("does not run diagnostics in non-TypeScript projects", async () => {
    await mkdir(join(workspace, "src"), { recursive: true });
    const registry = new ToolRegistry();
    registry.register(writeFileTool);

    const result = await registry.execute(
      "write_file",
      {
        path: "src/index.ts",
        content: 'export const value: number = "bad";\n',
      },
      createContext(workspace),
    );

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("TypeScript diagnostics:");
    expect(result.metadata?.typescriptDiagnostics).toBeUndefined();
  });
});

async function createTsProject(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createDiagnosticsRunner(): TypeScriptDiagnosticsRunner {
  return new TypeScriptDiagnosticsRunner(
    {
      enabled: true,
      command: process.execPath,
      args: [tscFixture, "src/index.ts"],
      timeoutMs: 10_000,
      maxDiagnostics: 10,
    },
    new NoopLogger(),
  );
}

function createContext(workspace: string) {
  return {
    cwd: workspace,
    sessionId: "test-session",
    permissionMode: "acceptEdits" as const,
    subagentDepth: 0,
    readTracker: new InMemoryReadTracker(),
    artifactStore: new PassthroughLargeResultStore(),
    diagnosticsRunner: createDiagnosticsRunner(),
    logger: new NoopLogger(),
  };
}

class DiagnosticsRepairProvider implements ModelProvider {
  readonly name = "diagnostics-repair";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return toolCall("write_file", {
        path: "src/index.ts",
        content: 'export const value: number = "bad";\n',
      });
    }

    const lastTool = [...input.messages]
      .reverse()
      .find((message) => message.role === "tool");
    expect(lastTool).toBeDefined();

    if (this.calls === 2) {
      expect(lastTool?.content).toContain("TypeScript diagnostics:");
      expect(lastTool?.content).toContain("TS2322");
      return toolCall("write_file", {
        path: "src/index.ts",
        content: "export const value: number = 1;\n",
      });
    }

    expect(lastTool?.content).toContain("No issues found.");
    return { content: "Fixed after diagnostics.", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

function toolCall(name: string, input: unknown): ModelResponse {
  return {
    content: "",
    toolCalls: [
      {
        id: `call_${name}_${Math.random().toString(16).slice(2)}`,
        name,
        input,
        rawArguments: JSON.stringify(input),
      },
    ],
  };
}

