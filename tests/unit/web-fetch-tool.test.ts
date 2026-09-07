import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { webFetchTool } from "../../src/tools/web-fetch.tool.js";

describe("web_fetch tool", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("fetches HTML and returns readable text", async () => {
    server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body><h1>Hello</h1><p>Sample page</p></body></html>");
    });
    const baseURL = await listen(server);

    const result = await webFetchTool.execute({ url: baseURL }, {} as never);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Hello Sample page");
  });

  it("returns a recoverable NetworkError for non-2xx responses", async () => {
    server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("failed");
    });
    const baseURL = await listen(server);

    const result = await webFetchTool.execute({ url: baseURL }, {} as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NetworkError");
      expect(result.content).toContain("failed");
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/`;
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
