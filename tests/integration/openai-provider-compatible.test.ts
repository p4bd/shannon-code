import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/core/errors.js";
import { OpenAICompatibleProvider } from "../../src/core/openai-provider.js";

describe("OpenAI-compatible provider", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("fails clearly when a gateway returns HTML instead of chat completion JSON", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Gateway Home</title>");
    });
    const baseURL = await listen(server);
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseURL,
      model: "mock-model",
    });

    await expect(
      provider.createMessage({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/invalid chat completion response/i);
    await expect(
      provider.createMessage({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("preserves the provider finish reason", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "partial" },
          finish_reason: "length",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseURL: await listen(server),
      model: "mock-model",
    });

    const result = await provider.createMessage({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.stopReason).toBe("length");
  });
});

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
