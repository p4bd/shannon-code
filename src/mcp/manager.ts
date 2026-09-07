import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { Logger } from "../utils/logger.js";
import { NoopLogger } from "../utils/logger.js";
import { McpClient, type McpServerConfig } from "./client.js";
import { createMcpToolAdapter } from "./tool-adapter.js";

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly logger: Logger;

  constructor(
    private readonly cwd: string,
    private readonly config: McpConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? new NoopLogger();
  }

  static async load(cwd: string, logger?: Logger): Promise<McpManager | undefined> {
    const config = await loadMcpConfig(cwd);
    return config ? new McpManager(cwd, config, logger) : undefined;
  }

  async registerTools(registry: ToolRegistry): Promise<void> {
    for (const [serverName, serverConfig] of Object.entries(this.config.servers)) {
      const client = new McpClient(serverName, serverConfig, this.cwd);
      this.clients.set(serverName, client);
      try {
        await client.start();
        const tools = await client.listTools();
        for (const tool of tools) {
          registry.register(
            createMcpToolAdapter({
              serverName,
              tool,
              client,
            }),
          );
        }
        this.logger.info("Registered MCP tools.", {
          serverName,
          count: tools.length,
        });
      } catch (error) {
        this.logger.warn("Failed to start MCP server.", {
          serverName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }
}

export async function loadMcpConfig(cwd: string): Promise<McpConfig | undefined> {
  const configPath = resolve(cwd, ".agent", "mcp.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Partial<McpConfig>;
  return {
    servers: Object.fromEntries(
      Object.entries(parsed.servers ?? {}).flatMap(([name, config]) => {
        if (!config || typeof config !== "object") {
          return [];
        }
        const record = config as Partial<McpServerConfig>;
        if (typeof record.command !== "string") {
          return [];
        }
        return [
          [
            name,
            {
              command: record.command,
              args: Array.isArray(record.args)
                ? record.args.filter((arg): arg is string => typeof arg === "string")
                : [],
              env:
                record.env && typeof record.env === "object"
                  ? Object.fromEntries(
                      Object.entries(record.env).filter(
                        (entry): entry is [string, string] =>
                          typeof entry[1] === "string",
                      ),
                    )
                  : undefined,
            },
          ],
        ];
      }),
    ),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
