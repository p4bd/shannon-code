import { describe, expect, it } from "vitest";
import { toolSearchTool } from "../../src/tools/tool-search.tool.js";

describe("tool_search tool", () => {
  it("returns matching tool schemas", async () => {
    const result = await toolSearchTool.execute({ query: "fetch" }, {} as never);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('"name": "web_fetch"');
    expect(result.content).toContain('"inputSchema"');
  });
});
