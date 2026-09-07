import { describe, expect, it } from "vitest";
import { fail } from "../../src/tools/result.js";

describe("tool result error guidance", () => {
  it("adds default recovery guidance to structured errors", () => {
    const result = fail({
      code: "FileNotFound",
      message: "File not found: src/missing.ts",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.suggestion).toContain("list_files");
      expect(result.content).toContain("Suggested recovery:");
      expect(result.content).toContain("grep_search");
    }
  });

  it("summarizes schemas for validation failures", () => {
    const result = fail({
      code: "SchemaValidationFailed",
      message: "Invalid input",
      details: {
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.schemaSummary).toContain("required=path");
      expect(result.error.suggestion).toContain("Expected schema:");
      expect(result.content).toContain("path:string");
    }
  });
});

