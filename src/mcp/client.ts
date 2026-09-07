import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  encodeJsonRpcMessage,
  isJsonRpcResponse,
  JsonRpcMessageParser,
  type JsonRpcResponse,
} from "./json-rpc.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly parser = new JsonRpcMessageParser();
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timeout: NodeJS.Timeout;
      cleanup(): void;
    }
  >();
  private stderr = "";

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly cwd: string,
  ) {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.parser.push(chunk)) {
          this.handleMessage(message);
        }
      } catch (error) {
        this.rejectAll(
          error instanceof Error ? error : new Error("Failed to parse MCP message."),
        );
      }
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("exit", (code, signal) => {
      this.rejectAll(
        new Error(
          `MCP server ${this.serverName} exited with code ${code ?? "null"} signal ${signal ?? "null"}.`,
        ),
      );
    });

    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "shannon-code",
        version: "0.1.0",
      },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown[] }).tools ?? [];
    return tools.flatMap((tool) => normalizeToolDefinition(tool));
  }

  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("tools/call", {
      name,
      arguments: args && typeof args === "object" ? args : {},
    }, signal);
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    this.process = undefined;
    if (child.exitCode !== null || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill();
    });
  }

  getStderr(): string {
    return this.stderr;
  }

  private request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.process;
    if (!child || child.killed) {
      return Promise.reject(new Error(`MCP server ${this.serverName} is not running.`));
    }

    const id = this.nextId++;
    const message = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pending.cleanup();
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id });
        reject(signal?.reason);
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(encodeJsonRpcMessage(message));
    });
  }

  private notify(method: string, params?: unknown): void {
    this.process?.stdin.write(
      encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }),
    );
  }

  private handleMessage(message: unknown): void {
    if (!isJsonRpcResponse(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    pending.cleanup();
    this.pending.delete(message.id);

    if (isFailure(message)) {
      pending.reject(
        new Error(
          `MCP error ${message.error.code}: ${message.error.message}`,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.cleanup();
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isFailure(response: JsonRpcResponse): response is Extract<JsonRpcResponse, { error: unknown }> {
  return "error" in response;
}

function normalizeToolDefinition(tool: unknown): McpToolDefinition[] {
  if (!tool || typeof tool !== "object") {
    return [];
  }

  const record = tool as Record<string, unknown>;
  if (typeof record.name !== "string") {
    return [];
  }

  return [
    {
      name: record.name,
      description:
        typeof record.description === "string" ? record.description : undefined,
      inputSchema:
        record.inputSchema && typeof record.inputSchema === "object"
          ? (record.inputSchema as Record<string, unknown>)
          : { type: "object", additionalProperties: true },
    },
  ];
}
