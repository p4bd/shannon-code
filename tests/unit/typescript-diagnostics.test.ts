import { describe, expect, it } from "vitest";
import {
  formatDiagnosticsResult,
  parseTypeScriptDiagnostics,
  parseTypeScriptDiagnosticsConfig,
} from "../../src/lsp/typescript-diagnostics.js";

describe("TypeScript diagnostics", () => {
  it("parses tsc diagnostic output", () => {
    const diagnostics = parseTypeScriptDiagnostics(
      [
        "src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/other.ts(2,3): warning TS6133: 'x' is declared but its value is never read.",
      ].join("\n"),
    );

    expect(diagnostics).toEqual([
      {
        file: "src/index.ts",
        line: 1,
        character: 14,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        file: "src/other.ts",
        line: 2,
        character: 3,
        severity: "warning",
        code: "TS6133",
        message: "'x' is declared but its value is never read.",
      },
    ]);
  });

  it("normalizes diagnostics config with defaults", () => {
    const config = parseTypeScriptDiagnosticsConfig({
      typescript: {
        enabled: false,
        command: "node",
        args: ["fixture.mjs"],
        timeoutMs: 1234,
        maxDiagnostics: 7,
      },
    });

    expect(config).toEqual({
      enabled: false,
      command: "node",
      args: ["fixture.mjs"],
      timeoutMs: 1234,
      maxDiagnostics: 7,
    });
  });

  it("formats diagnostics for tool result content", () => {
    const content = formatDiagnosticsResult({
      status: "diagnostics",
      command: "npx tsc --noEmit",
      exitCode: 2,
      diagnostics: [
        {
          file: "src/index.ts",
          line: 1,
          character: 14,
          severity: "error",
          code: "TS2322",
          message: "Type mismatch.",
        },
      ],
    });

    expect(content).toContain("TypeScript diagnostics:");
    expect(content).toContain("src/index.ts:1:14 TS2322 error");
  });
});

