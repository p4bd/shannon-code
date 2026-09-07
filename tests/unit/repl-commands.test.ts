import { describe, expect, it } from "vitest";
import { parseReplCommand } from "../../src/cli/commands.js";

describe("parseReplCommand", () => {
  it("parses basic commands", () => {
    expect(parseReplCommand("/help")).toEqual({ name: "help" });
    expect(parseReplCommand("/exit")).toEqual({ name: "exit" });
    expect(parseReplCommand("hello")).toBeUndefined();
  });

  it("parses command arguments", () => {
    expect(parseReplCommand("/resume abc")).toEqual({
      name: "resume",
      sessionId: "abc",
    });
    expect(parseReplCommand("/memory add hello")).toEqual({
      name: "memory",
      args: "add hello",
    });
    expect(parseReplCommand("/skill commit staged changes")).toEqual({
      name: "skill",
      skillName: "commit",
      args: "staged changes",
    });
  });

  it("parses plan workflow commands", () => {
    expect(parseReplCommand("/plan")).toEqual({
      name: "plan",
      action: "mode",
      args: "",
    });
    expect(parseReplCommand("/plan add tests")).toEqual({
      name: "plan",
      action: "start",
      args: "add tests",
    });
    expect(parseReplCommand("/plan approve")).toEqual({
      name: "plan",
      action: "approve",
      args: "",
    });
    expect(parseReplCommand("/plan revise add typecheck")).toEqual({
      name: "plan",
      action: "revise",
      args: "add typecheck",
    });
    expect(parseReplCommand("/plan cancel")).toEqual({
      name: "plan",
      action: "cancel",
      args: "",
    });
  });
});
