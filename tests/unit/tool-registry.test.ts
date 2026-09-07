import { describe, expect, it } from "vitest";
import {
  InMemoryReadTracker,
  type ReadTracker,
} from "../../src/context/read-tracker.js";
import { PassthroughLargeResultStore } from "../../src/context/large-result-store.js";
import { readFileTool } from "../../src/tools/read-file.tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { NoopLogger } from "../../src/utils/logger.js";

describe("ToolRegistry", () => {
  it("returns a structured error for unknown tools", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("missing_tool", {}, createContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UnknownError");
      expect(result.recoverable).toBe(true);
    }
  });

  it("validates tool input before execution", async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const result = await registry.execute(
      "read_file",
      { path: 123 },
      createContext(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SchemaValidationFailed");
      expect(result.content).toContain("Validation issues");
    }
  });

  it("generates portable model schemas from tool validators", () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const schema = registry.getModelToolDefinitions()[0]?.inputSchema;

    expect(schema).not.toHaveProperty("$schema");
    expect(schema?.required).toEqual(["path"]);
    expect(schema?.properties?.path).toMatchObject({
      type: "string",
      description: expect.any(String),
    });
  });
});

function createContext(readTracker: ReadTracker = new InMemoryReadTracker()) {
  return {
    cwd: process.cwd(),
    sessionId: "test-session",
    permissionMode: "default" as const,
    readTracker,
    artifactStore: new PassthroughLargeResultStore(),
    logger: new NoopLogger(),
  };
}
