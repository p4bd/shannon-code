import { describe, expect, it } from "vitest";
import {
  encodeJsonRpcMessage,
  JsonRpcMessageParser,
} from "../../src/mcp/json-rpc.js";

describe("MCP JSON-RPC framing", () => {
  it("encodes and parses newline-delimited messages", () => {
    const parser = new JsonRpcMessageParser();
    const encoded = encodeJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });

    expect(parser.push(encoded)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
  });

  it("parses multiple messages from one chunk", () => {
    const parser = new JsonRpcMessageParser();
    const first = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: "a" });
    const second = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 2, result: "b" });

    expect(parser.push(Buffer.concat([first, second]))).toEqual([
      { jsonrpc: "2.0", id: 1, result: "a" },
      { jsonrpc: "2.0", id: 2, result: "b" },
    ]);
  });

  it("buffers partial messages", () => {
    const parser = new JsonRpcMessageParser();
    const encoded = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: "ok" });
    const first = encoded.subarray(0, 10);
    const second = encoded.subarray(10);

    expect(parser.push(first)).toEqual([]);
    expect(parser.push(second)).toEqual([
      { jsonrpc: "2.0", id: 1, result: "ok" },
    ]);
  });
});
