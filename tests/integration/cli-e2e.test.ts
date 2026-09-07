import { execFile, spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI end-to-end", () => {
  let workspace: string;
  let server: Server | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-cli-e2e-"));
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  it("prints help without requiring an API key", async () => {
    const result = await runCli(["--help"], {
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: "",
    });

    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("shannon code [options]");
    expect(result.stdout).toContain("OPENAI_API_KEY");
  });

  it("starts in one-shot mode, streams through a mock API, calls tools, and saves a session", async () => {
    await writeFile(join(workspace, "fixture.txt"), "hello from fixture\n", "utf8");
    const requests: unknown[] = [];
    server = createCliMockServer(requests);
    const baseURL = await listen(server);

    const result = await runCli(
      ["--max-turns", "4", "Read fixture.txt and summarize it."],
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: baseURL,
        OPENAI_MODEL: "mock-model",
      },
    );

    expect(result.stdout).toContain(`Workspace: ${workspace}`);
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Agent > Read fixture OK");
    expect(result.stderr).toBe("");
    expect(requests).toHaveLength(2);

    const sessionsDir = join(workspace, ".agent", "sessions");
    const sessions = (await readdir(sessionsDir)).filter((entry) =>
      entry.endsWith(".jsonl"),
    );
    expect(sessions).toHaveLength(1);
    const session = await readFile(join(sessionsDir, sessions[0]!), "utf8");
    expect(session).toContain("Read fixture OK");
    expect(session).toContain("hello from fixture");
  });

  it("supports interactive REPL commands and a streamed tool-using prompt", async () => {
    await writeFile(join(workspace, "fixture.txt"), "hello from repl\n", "utf8");
    const requests: unknown[] = [];
    server = createCliMockServer(requests, "REPL read OK");
    const baseURL = await listen(server);

    const result = await runInteractiveCli(
      [
        "/help",
        "/cost",
        "Read fixture.txt in REPL.",
        "/memory add remember repl mode",
        "/memory list",
        "/compact",
        "/exit",
      ],
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: baseURL,
        OPENAI_MODEL: "mock-model",
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Shannon Code REPL. Session:");
    expect(result.stdout).toContain(`Workspace: ${workspace}`);
    expect(result.stdout).toContain("You > ");
    expect(result.stdout).toContain("/exit");
    expect(result.stdout).toContain("Added memory");
    expect(result.stdout).toContain("remember repl mode");
    expect(result.stdout).toContain("Estimated context tokens:");
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Agent > REPL read OK");
    expect(result.stdout).toMatch(/Compacted|No compaction needed/);
    expect(result.stdout).toContain("Saved session");
    expect(requests).toHaveLength(2);
  });

  it("runs the built dist CLI after compilation", async () => {
    await writeFile(join(workspace, "fixture.txt"), "hello from dist\n", "utf8");
    await execFileAsync(process.execPath, [
      resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.json",
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const requests: unknown[] = [];
    server = createCliMockServer(requests, "Dist read OK");
    const baseURL = await listen(server);

    const help = await runDistShannon(["code", "--help"], {
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: "",
    });
    expect(help.stdout).toContain("shannon code [options]");
    expect(help.stderr).toBe("");

    let externalWorkspace: string | undefined;
    let fakePackageRoot: string | undefined;
    try {
      externalWorkspace = await mkdtemp(join(tmpdir(), "shannon-external-workspace-"));
      fakePackageRoot = await mkdtemp(resolve(process.cwd(), ".tmp-shannon-fake-"));
      await cp(resolve(process.cwd(), "dist"), join(fakePackageRoot, "dist"), {
        recursive: true,
      });
      await writeFile(
        join(fakePackageRoot, ".env"),
        [
          "OPENAI_API_KEY=root-env-key",
          `OPENAI_BASE_URL=${baseURL}`,
          "OPENAI_MODEL=root-env-model",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(externalWorkspace, "fixture.txt"),
        "hello from external workspace\n",
        "utf8",
      );

      const requestOffset = requests.length;
      const wrapperResult = await runDistShannonFrom(
        fakePackageRoot,
        externalWorkspace,
        ["code", "--max-turns", "4", "Read fixture.txt."],
        {
          OPENAI_API_KEY: "wrong-env-key",
          OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
          OPENAI_MODEL: "wrong-env-model",
        },
      );

      expect(wrapperResult.stderr).toBe("");
      expect(wrapperResult.stdout).toContain(`Workspace: ${externalWorkspace}`);
      expect(wrapperResult.stdout).toContain("[tool] read_file");
      expect(wrapperResult.stdout).toContain("Agent > Dist read OK");
      expect(requests).toHaveLength(requestOffset + 2);
      expect((requests[requestOffset] as { model?: string }).model).toBe(
        "root-env-model",
      );

      const externalSessionsDir = join(externalWorkspace, ".agent", "sessions");
      const externalSessions = (await readdir(externalSessionsDir)).filter((entry) =>
        entry.endsWith(".jsonl"),
      );
      expect(externalSessions).toHaveLength(1);
    } finally {
      if (externalWorkspace) {
        await rm(externalWorkspace, { recursive: true, force: true });
      }
      if (fakePackageRoot) {
        await rm(fakePackageRoot, { recursive: true, force: true });
      }
    }

    const result = await runDistCli(["--max-turns", "4", "Read fixture.txt."], {
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: baseURL,
      OPENAI_MODEL: "mock-model",
    });

    expect(result.stdout).toContain(`Workspace: ${workspace}`);
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Agent > Dist read OK");
    expect(result.stderr).toBe("");
    expect(requests).toHaveLength(4);
  }, 60_000);

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
        env: {
          ...process.env,
          ...env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );

    return { stdout, stderr };
  }

  async function runDistCli(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    const cliEntry = resolve(process.cwd(), "dist", "cli", "index.js");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, ...args],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ...env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );

    return { stdout, stderr };
  }

  async function runDistShannon(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    const cliEntry = resolve(process.cwd(), "dist", "cli", "shannon.js");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, ...args],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ...env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );

    return { stdout, stderr };
  }

  async function runDistShannonFrom(
    packageRoot: string,
    cwd: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    const cliEntry = resolve(packageRoot, "dist", "cli", "shannon.js");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, ...args],
      {
        cwd,
        env: {
          ...process.env,
          ...env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
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
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const tsxCli = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const cliEntry = resolve(process.cwd(), "src", "cli", "index.ts");
    const child = spawn(process.execPath, [tsxCli, cliEntry], {
      cwd: workspace,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
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
      if (stdout.endsWith("You > ")) {
        writeNextLine();
      }
    });

    const code = await waitForExit(child, 30_000);
    return { stdout, stderr, code };
  }
});

function createCliMockServer(requests: unknown[], finalContent = "Read fixture OK"): Server {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const body = await readJsonBody(request);
    requests.push(body);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const hasToolResult = Array.isArray(body.messages)
      ? body.messages.some((message: { role?: string }) => message.role === "tool")
      : false;
    if (hasToolResult) {
      writeSse(response, chunk({ delta: { role: "assistant", content: finalContent } }));
      writeSse(response, chunk({ delta: {}, finishReason: "stop" }));
      response.end("data: [DONE]\n\n");
      return;
    }

    writeSse(
      response,
      chunk({
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_read_fixture",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "fixture.txt" }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      }),
    );
    response.end("data: [DONE]\n\n");
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
