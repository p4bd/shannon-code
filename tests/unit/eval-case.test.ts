import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandGeneratedFile,
  loadEvalCase,
  normalizeEvalCase,
} from "../../src/evals/case.js";

describe("eval case parser", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-eval-case-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("loads standard YAML eval cases", async () => {
    const path = join(workspace, "case.yaml");
    await writeFile(
      path,
      [
        "name: yaml case",
        "prompt: Read the file.",
        "maxTurns: 3",
        "permissionMode: acceptEdits",
        "workspace:",
        "  files:",
        "    README.md: |",
        "      hello yaml",
        "    huge.txt:",
        "      repeat: x",
        "      count: 4",
        "mock:",
        "  supportsPromptCaching: true",
        "  steps:",
        "    - content: ''",
        "      toolCalls:",
        "        - name: read_file",
        "          input:",
        "            path: README.md",
        "assertions:",
        "  - type: file_contains",
        "    path: README.md",
        "    text: hello",
        "",
      ].join("\n"),
      "utf8",
    );

    const evalCase = await loadEvalCase(path);

    expect(evalCase.name).toBe("yaml case");
    expect(evalCase.maxTurns).toBe(3);
    expect(evalCase.permissionMode).toBe("acceptEdits");
    expect(evalCase.mock?.supportsPromptCaching).toBe(true);
    expect(evalCase.mock?.steps[0]?.toolCalls?.[0]).toMatchObject({
      name: "read_file",
      input: { path: "README.md" },
    });
    expect(evalCase.assertions[0]).toEqual({
      type: "file_contains",
      path: "README.md",
      text: "hello",
    });
    expect(expandGeneratedFile(evalCase.workspace.files["huge.txt"] ?? "")).toBe("xxxx");
  });

  it("normalizes object-form assertions", () => {
    const evalCase = normalizeEvalCase({
      name: "object assertions",
      prompt: "Check file.",
      mock: {
        steps: [{ content: "done" }],
      },
      workspace: {
        files: {
          "a.txt": "alpha",
        },
      },
      assertions: {
        file_exists: { path: "a.txt" },
        tool_not_called: { name: "write_file" },
      },
    });

    expect(evalCase.assertions).toEqual([
      { type: "file_exists", path: "a.txt" },
      { type: "tool_not_called", name: "write_file" },
    ]);
  });

  it("rejects unsupported assertions", () => {
    expect(() =>
      normalizeEvalCase({
        name: "bad assertions",
        prompt: "Check file.",
        mock: {
          steps: [{ content: "done" }],
        },
        assertions: [{ type: "missing_assertion" }],
      }),
    ).toThrow(/unsupported assertion/);
  });
});
