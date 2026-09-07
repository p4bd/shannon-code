import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
  it("joins positional arguments as a one-shot prompt", () => {
    expect(parseArgs(["hello", "world"])).toEqual({
      prompt: "hello world",
      help: false,
      version: false,
      permissionMode: "default",
      resume: undefined,
      maxTurns: undefined,
    });
  });

  it("detects help and version flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("parses permission mode aliases", () => {
    expect(parseArgs(["--yolo", "do", "it"]).permissionMode).toBe(
      "bypassPermissions",
    );
    expect(parseArgs(["--plan", "inspect"]).permissionMode).toBe("plan");
    expect(parseArgs(["--accept-edits", "change"]).permissionMode).toBe(
      "acceptEdits",
    );
    expect(parseArgs(["--dont-ask", "check"]).permissionMode).toBe("dontAsk");
  });

  it("parses explicit permission mode", () => {
    expect(
      parseArgs(["--permission-mode", "acceptEdits", "change"]).permissionMode,
    ).toBe("acceptEdits");
    expect(parseArgs(["--permission-mode=plan", "inspect"]).permissionMode).toBe(
      "plan",
    );
  });

  it("parses resume and max turns options", () => {
    expect(parseArgs(["--resume", "hello"]).resume).toBe(true);
    expect(parseArgs(["--resume=abc123"]).resume).toBe("abc123");
    expect(
      parseArgs([
        "--resume",
        "123e4567-e89b-12d3-a456-426614174000",
        "continue",
      ]).resume,
    ).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(parseArgs(["--max-turns", "3", "hello"]).maxTurns).toBe(3);
    expect(parseArgs(["--max-turns=4", "hello"]).maxTurns).toBe(4);
  });
});
