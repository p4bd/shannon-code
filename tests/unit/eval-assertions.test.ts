import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../../src/core/agent.js";
import { runEvalAssertions } from "../../src/evals/assertions.js";
import type { EvalAssertion } from "../../src/evals/case.js";

describe("eval assertions", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-eval-assertions-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("passes file, session, command, and tool assertions", async () => {
    await writeFile(join(workspace, "result.txt"), "alpha\nbeta\n", "utf8");

    const assertions: EvalAssertion[] = [
      { type: "file_exists", path: "result.txt" },
      { type: "file_contains", path: "result.txt", text: "alpha" },
      { type: "file_not_contains", path: "result.txt", text: "gamma" },
      {
        type: "command_succeeds",
        command: `"${process.execPath}" -e "console.log('ok')"`,
      },
      {
        type: "stdout_contains",
        command: `"${process.execPath}" -e "console.log('eval-ok')"`,
        text: "eval-ok",
      },
      { type: "session_contains", text: "session marker" },
      { type: "tool_called", name: "read_file" },
      { type: "tool_not_called", name: "write_file" },
    ];

    const results = await runEvalAssertions({
      assertions,
      context: {
        cwd: workspace,
        result: createResult(),
      },
    });

    expect(results).toHaveLength(assertions.length);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("reports assertion failures without throwing", async () => {
    await writeFile(join(workspace, "result.txt"), "alpha\n", "utf8");

    const results = await runEvalAssertions({
      assertions: [
        { type: "file_contains", path: "result.txt", text: "missing" },
        { type: "tool_called", name: "write_file" },
      ],
      context: {
        cwd: workspace,
        result: createResult(),
      },
    });

    expect(results.map((result) => result.passed)).toEqual([false, false]);
    expect(results[0]?.message).toContain("did not contain");
    expect(results[1]?.message).toContain("was not called");
  });
});

function createResult(): AgentRunResult {
  return {
    content: "final content",
    messages: [
      { role: "user", content: "session marker" },
      { role: "assistant", content: "assistant response" },
    ],
    toolResults: [
      {
        toolCall: {
          id: "call-1",
          name: "read_file",
          input: { path: "result.txt" },
          rawArguments: "{\"path\":\"result.txt\"}",
        },
        result: {
          ok: true,
          content: "alpha",
        },
      },
    ],
    stoppedByMaxTurns: false,
  };
}
