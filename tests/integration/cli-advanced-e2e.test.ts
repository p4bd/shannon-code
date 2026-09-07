import { execFile, spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface ChatRequest {
  messages?: Array<{ role?: string; content?: string }>;
  tools?: Array<{ name?: string; function?: { name?: string } }>;
  stream?: boolean;
}

interface ScriptedStep {
  content?: string;
  toolCalls?: Array<{ name: string; input: unknown; id?: string }>;
}

describe("CLI advanced end-to-end", () => {
  let workspace: string;
  let server: Server | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-cli-advanced-"));
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  it("resumes the latest session in one-shot mode", async () => {
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        { content: "First session saved." },
        { content: "Resume saw previous context." },
      ],
      requests,
    );
    const env = createEnv(await listen(server));

    const first = await runCli(["Remember this first turn."], env);
    const second = await runCli(["--resume", "Continue from prior context."], env);

    expect(first.stdout).toContain("First session saved.");
    expect(second.stdout).toContain("Resume saw previous context.");
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages?.some(
        (message) =>
          message.role === "assistant" &&
          message.content?.includes("First session saved."),
      ),
    ).toBe(true);
    expect(
      requests[1]?.messages?.some(
        (message) =>
          message.role === "user" &&
          message.content?.includes("Continue from prior context."),
      ),
    ).toBe(true);
  });

  it("resumes a specified session from inside the REPL", async () => {
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        { content: "Exact session marker." },
        { content: "REPL resumed exact session." },
      ],
      requests,
    );
    const env = createEnv(await listen(server));

    await runCli(["Seed exact session."], env);
    const [sessionFile] = (await readdir(join(workspace, ".agent", "sessions")))
      .filter((entry) => entry.endsWith(".jsonl"));
    const sessionId = sessionFile!.replace(/\.jsonl$/i, "");

    const result = await runInteractiveCli(
      [`/resume ${sessionId}`, "Continue exact session.", "/exit"],
      env,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Resumed session ${sessionId}.`);
    expect(result.stdout).toContain("REPL resumed exact session.");
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages?.some(
        (message) =>
          message.role === "assistant" &&
          message.content?.includes("Exact session marker."),
      ),
    ).toBe(true);
  });

  it("covers REPL plan revise, cancel, and approve execution", async () => {
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        { content: "Plan v1: inspect then change." },
        { content: "Plan v2: add verification." },
        { content: "Executable plan: write planned.txt." },
        {
          toolCalls: [
            {
              name: "write_file",
              input: { path: "planned.txt", content: "done\n" },
            },
          ],
        },
        { content: "Executed planned file." },
      ],
      requests,
    );

    const result = await runInteractiveCli(
      [
        "/plan Create canceled plan",
        "/plan status",
        "/plan revise add verification",
        "/plan cancel",
        "/plan Create executable plan",
        "/plan approve",
        "/exit",
      ],
      createEnv(await listen(server)),
      ["--accept-edits"],
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Plan saved to .agent/plans/");
    expect(result.stdout).toContain("Pending plan");
    expect(result.stdout).toContain("Canceled plan");
    expect(result.stdout).toContain("[tool] write_file");
    expect(result.stdout).toContain("Executed plan");
    expect(await readFile(join(workspace, "planned.txt"), "utf8")).toBe("done\n");
    expect(requests).toHaveLength(5);
  });

  it("asks for REPL approval before running write tools in default mode", async () => {
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "write_file",
              input: { path: "approved.txt", content: "approved\n" },
            },
          ],
        },
        { content: "Approved write complete." },
      ],
      requests,
    );

    const result = await runInteractiveCli(
      ["Create approved.txt.", "y", "/exit"],
      createEnv(await listen(server)),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Permission request: write_file");
    expect(result.stdout).toContain("Approve tool? yes/no/always");
    expect(result.stdout).toContain("[tool] write_file -> ok");
    expect(result.stdout).toContain("Approved write complete.");
    expect(await readFile(join(workspace, "approved.txt"), "utf8")).toBe(
      "approved\n",
    );
    expect(requests).toHaveLength(2);
  });

  it("reports one-shot write approval unavailability without writing", async () => {
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "write_file",
              input: { path: "blocked.txt", content: "blocked\n" },
            },
          ],
        },
        { content: "Blocked write handled." },
      ],
      requests,
    );

    const result = await runCli(
      ["--max-turns", "4", "Create blocked.txt."],
      createEnv(await listen(server)),
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool] write_file -> PermissionDenied recoverable");
    expect(result.stdout).toContain("interactive approval is not available in this run");
    expect(result.stdout).toContain("Blocked write handled.");
    await expect(readFile(join(workspace, "blocked.txt"), "utf8")).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("runs web_fetch through the CLI against a local HTTP page", async () => {
    let contentServer: Server | undefined;
    try {
      contentServer = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body><h1>Shannon Web Marker</h1></body></html>");
      });
      const pageUrl = (await listen(contentServer)).replace(/\/v1$/, "/page");

      const requests: ChatRequest[] = [];
      server = createScriptedStreamingServer(
        [
          {
            toolCalls: [
              {
                name: "web_fetch",
                input: { url: pageUrl, maxLength: 500 },
              },
            ],
          },
          { content: "Fetched local page." },
        ],
        requests,
      );

      const result = await runCli(
        ["--max-turns", "4", "Fetch the local test page."],
        createEnv(await listen(server)),
      );

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("[tool] web_fetch -> ok");
      expect(result.stdout).toContain("Shannon Web Marker");
      expect(result.stdout).toContain("Fetched local page.");
      expect(requests).toHaveLength(2);
    } finally {
      await closeServer(contentServer);
    }
  });

  it("runs tool_search through the CLI and returns matching tool schemas", async () => {
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "tool_search",
              input: { query: "fetch" },
            },
          ],
        },
        { content: "Tool search complete." },
      ],
      requests,
    );

    const result = await runCli(
      ["--max-turns", "4", "Search tools for fetch."],
      createEnv(await listen(server)),
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool] tool_search -> ok");
    expect(result.stdout).toContain("web_fetch");
    expect(result.stdout).toContain("Tool search complete.");
    expect(requests).toHaveLength(2);
  });

  it("lets a plan execution recover from a failed edit", async () => {
    await writeFile(join(workspace, "recover.txt"), "old\n", "utf8");
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        { content: "Plan: edit recover.txt after checking current content." },
        {
          toolCalls: [
            {
              name: "edit_file",
              input: {
                path: "recover.txt",
                oldString: "old",
                newString: "new",
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "read_file",
              input: { path: "recover.txt" },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "edit_file",
              input: {
                path: "recover.txt",
                oldString: "old",
                newString: "new",
              },
            },
          ],
        },
        { content: "Recovered plan execution." },
      ],
      requests,
    );

    const result = await runInteractiveCli(
      ["/plan Fix recover file", "/plan approve", "/exit"],
      createEnv(await listen(server)),
      ["--accept-edits"],
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ReadBeforeEditRequired");
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Recovered plan execution.");
    expect(await readFile(join(workspace, "recover.txt"), "utf8")).toBe("new\n");
    expect(requests).toHaveLength(5);
  });

  it("loads and runs a project skill from the CLI", async () => {
    await mkdir(join(workspace, ".agent", "skills", "demo"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "skills", "demo", "SKILL.md"),
      [
        "---",
        "name: demo",
        "description: Demo skill",
        "allowed_tools: [read_file]",
        "---",
        "Read the requested fixture and answer concisely.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(workspace, "fixture.txt"), "hello skill\n", "utf8");
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "read_file",
              input: { path: "fixture.txt" },
            },
          ],
        },
        { content: "Skill complete." },
      ],
      requests,
    );

    const result = await runInteractiveCli(
      ["/skill", "/skill demo inspect fixture.txt", "/exit"],
      createEnv(await listen(server)),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("demo  Demo skill");
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Skill complete.");
    expect(requests[0]?.messages?.at(-1)?.content).toContain('Use the "demo" skill.');
    expect(requests[0]?.tools?.map((tool) => tool.function?.name ?? tool.name)).toEqual([
      "read_file",
    ]);
  });

  it("runs a fork-mode project skill from the CLI", async () => {
    await mkdir(join(workspace, ".agent", "skills", "forkdemo"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "skills", "forkdemo", "SKILL.md"),
      [
        "---",
        "name: forkdemo",
        "description: Fork demo skill",
        "mode: fork",
        "allowed_tools: [read_file]",
        "---",
        "Run in an isolated fork and inspect the requested file.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(workspace, "fixture.txt"), "hello fork skill\n", "utf8");
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "read_file",
              input: { path: "fixture.txt" },
            },
          ],
        },
        { content: "Fork skill complete." },
      ],
      requests,
    );

    const result = await runInteractiveCli(
      ["/skill forkdemo inspect fixture.txt", "/exit"],
      createEnv(await listen(server)),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Fork skill complete.");
    expect(requests[0]?.messages?.at(-1)?.content).toContain(
      'Use the "forkdemo" skill.',
    );
    expect(requests[0]?.tools?.map((tool) => tool.function?.name ?? tool.name)).toEqual([
      "read_file",
    ]);

    const [sessionFile] = (await readdir(join(workspace, ".agent", "sessions")))
      .filter((entry) => entry.endsWith(".jsonl"));
    const session = await readFile(join(workspace, ".agent", "sessions", sessionFile!), "utf8");
    expect(session).not.toContain('Use the "forkdemo" skill.');
    expect(session).not.toContain("Fork skill complete.");
  });

  it("loads MCP tools during CLI startup", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "mcp.json"),
      JSON.stringify({
        servers: {
          test: {
            command: process.execPath,
            args: [resolve(process.cwd(), "tests", "fixtures", "mcp-test-server.mjs")],
          },
        },
      }),
      "utf8",
    );
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "mcp__test__add",
              input: { a: 2, b: 5 },
            },
          ],
        },
        { content: "MCP add complete." },
      ],
      requests,
    );

    const result = await runCli(["--max-turns", "4", "Use MCP add."], createEnv(await listen(server)));

    expect(result.stderr).toContain("Registered MCP tools");
    expect(result.stdout).toContain("[tool] mcp__test__add");
    expect(result.stdout).toContain("MCP add complete.");
    expect(requests[0]?.tools?.map((tool) => tool.function?.name ?? tool.name)).toContain(
      "mcp__test__add",
    );
  });

  it("lets the model recover from an MCP tool failure", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "mcp.json"),
      JSON.stringify({
        servers: {
          test: {
            command: process.execPath,
            args: [resolve(process.cwd(), "tests", "fixtures", "mcp-test-server.mjs")],
          },
        },
      }),
      "utf8",
    );
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        { toolCalls: [{ name: "mcp__test__fail", input: {} }] },
        { toolCalls: [{ name: "mcp__test__add", input: { a: 2, b: 5 } }] },
        { content: "Recovered from MCP failure." },
      ],
      requests,
    );

    const result = await runCli(
      ["--max-turns", "5", "Recover from MCP failure."],
      createEnv(await listen(server)),
    );

    expect(result.stderr).toContain("Registered MCP tools");
    expect(result.stdout).toContain("[tool] mcp__test__fail -> McpError recoverable");
    expect(result.stdout).toContain("[tool] mcp__test__add");
    expect(result.stdout).toContain("Recovered from MCP failure.");
    expect(requests).toHaveLength(3);
  });

  it("continues when an MCP server fails to start", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "mcp.json"),
      JSON.stringify({
        servers: {
          broken: {
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        },
      }),
      "utf8",
    );
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [{ content: "Continued without MCP." }],
      requests,
    );

    const result = await runCli(
      ["--max-turns", "2", "Answer without MCP."],
      createEnv(await listen(server)),
    );

    expect(result.stderr).toContain("Failed to start MCP server");
    expect(result.stdout).toContain("Continued without MCP.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools?.map((tool) => tool.function?.name ?? tool.name)).not.toContain(
      "mcp__broken__add",
    );
  });

  it("runs CLI hooks during tool execution", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(join(workspace, "original.txt"), "original content\n", "utf8");
    await writeFile(join(workspace, "modified.txt"), "modified content\n", "utf8");
    await writeFile(
      join(workspace, ".agent", "hooks.json"),
      JSON.stringify({
        hooks: [
          {
            event: "PreToolUse",
            matcher: "read_file",
            command: process.execPath,
            args: [
              resolve(process.cwd(), "tests", "fixtures", "hook-fixture.mjs"),
              "modify-read-target",
            ],
          },
          {
            event: "PostToolUse",
            matcher: "read_file",
            command: process.execPath,
            args: [
              resolve(process.cwd(), "tests", "fixtures", "hook-fixture.mjs"),
              "append-tool",
            ],
          },
        ],
      }),
      "utf8",
    );
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        { toolCalls: [{ name: "read_file", input: { path: "original.txt" } }] },
        { content: "Hooked read complete." },
      ],
      requests,
    );

    const result = await runCli(
      ["--max-turns", "4", "Read original.txt."],
      createEnv(await listen(server)),
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("modified content");
    expect(result.stdout).toContain("post hook saw read_file");
    expect(result.stdout).toContain("Hooked read complete.");
    expect(requests).toHaveLength(2);
  });

  it("runs TypeScript diagnostics from the CLI after writing TS files", async () => {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
      "utf8",
    );
    await writeFile(
      join(workspace, ".agent", "diagnostics.json"),
      JSON.stringify({
        typescript: {
          command: process.execPath,
          args: [
            resolve(process.cwd(), "tests", "fixtures", "tsc-diagnostics-fixture.mjs"),
            "src/index.ts",
          ],
          timeoutMs: 10_000,
          maxDiagnostics: 5,
        },
      }),
      "utf8",
    );
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "write_file",
              input: {
                path: "src/index.ts",
                content: 'export const value: number = "bad";\n',
              },
            },
          ],
        },
        { content: "Diagnostics observed." },
      ],
      requests,
    );

    const result = await runCli(
      ["--accept-edits", "--max-turns", "4", "Write a bad TypeScript file."],
      createEnv(await listen(server)),
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool] write_file");
    expect(result.stdout).toContain("TypeScript diagnostics");
    expect(result.stdout).toContain("Diagnostics observed.");
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages?.some(
        (message) => message.role === "tool" && message.content?.includes("TS2322"),
      ),
    ).toBe(true);
  });

  it("runs the sub-agent tool through the CLI startup path", async () => {
    await writeFile(join(workspace, "fixture.txt"), "hello subagent\n", "utf8");
    const requests: ChatRequest[] = [];
    server = createScriptedStreamingServer(
      [
        {
          toolCalls: [
            {
              name: "agent",
              input: {
                agentType: "explore",
                prompt: "Inspect fixture.txt",
                maxTurns: 3,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "read_file",
              input: { path: "fixture.txt" },
            },
          ],
        },
        { content: "Child found fixture.txt." },
        { content: "Parent received child summary." },
      ],
      requests,
    );

    const result = await runCli(["--max-turns", "4", "Delegate exploration."], createEnv(await listen(server)));

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool] agent");
    expect(result.stdout).toContain("Parent received child summary.");
    expect(requests).toHaveLength(4);
    expect(requests[1]?.messages?.at(-1)?.content).toContain("Delegated task:");
  });

  async function runCli(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    const tsxCli = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const cliEntry = resolve(process.cwd(), "src", "cli", "index.ts");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxCli, cliEntry, ...args],
      {
        cwd: workspace,
        env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );

    return { stdout, stderr };
  }

  async function runInteractiveCli(
    lines: string[],
    env: Record<string, string>,
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const tsxCli = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const cliEntry = resolve(process.cwd(), "src", "cli", "index.ts");
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd: workspace,
      env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const pending = [...lines];
    const writeNextLine = () => {
      const next = pending.shift();
      if (next === undefined) {
        return;
      }
      child.stdin.write(`${next}\n`);
      if (pending.length === 0) {
        child.stdin.end();
      }
    };
    child.stdout.on("data", () => {
      if (
        stdout.endsWith("You > ") ||
        stdout.endsWith("Approve tool? yes/no/always [y/N/a]: ")
      ) {
        writeNextLine();
      }
    });

    const code = await waitForExit(child, 30_000);
    return { stdout, stderr, code };
  }
});

function createEnv(baseURL: string): Record<string, string> {
  return {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: baseURL,
    OPENAI_MODEL: "mock-model",
  };
}

function createScriptedStreamingServer(
  steps: ScriptedStep[],
  requests: ChatRequest[],
): Server {
  let index = 0;
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const body = await readJsonBody(request);
    requests.push(body as ChatRequest);
    const step = steps[index++] ?? { content: "No scripted response remained." };
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(chatCompletion(step)));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (step.toolCalls?.length) {
      writeSse(
        response,
        chunk({
          delta: {
            role: "assistant",
            tool_calls: step.toolCalls.map((toolCall, toolIndex) => ({
              index: toolIndex,
              id: toolCall.id ?? `call_${toolIndex}_${toolCall.name}`,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.input),
              },
            })),
          },
          finishReason: "tool_calls",
        }),
      );
      response.end("data: [DONE]\n\n");
      return;
    }

    writeSse(response, chunk({ delta: { role: "assistant", content: step.content ?? "" } }));
    writeSse(response, chunk({ delta: {}, finishReason: "stop" }));
    response.end("data: [DONE]\n\n");
  });
}

function chatCompletion(step: ScriptedStep): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        finish_reason: step.toolCalls?.length ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: step.toolCalls?.length ? null : (step.content ?? ""),
          tool_calls: step.toolCalls?.map((toolCall, toolIndex) => ({
            id: toolCall.id ?? `call_${toolIndex}_${toolCall.name}`,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input),
            },
          })),
        },
      },
    ],
  };
}

function chunk(input: {
  delta: Record<string, unknown>;
  finishReason?: string | null;
}): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
  };
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI process did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}
