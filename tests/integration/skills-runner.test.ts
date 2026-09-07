import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";
import { runSkill } from "../../src/skills/runner.js";
import type { Skill } from "../../src/skills/types.js";

describe("skill runner", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-skill-runner-"));
    await writeFile(join(workspace, "package.json"), "{}", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("applies allowed_tools restrictions for inline skills", async () => {
    const provider = new DisallowedToolThenFinalProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 2 });
    const skill = createSkill({
      allowedTools: ["read_file"],
      mode: "inline",
    });

    const result = await runSkill({
      skill,
      args: "try a shell command",
      agent,
      provider,
      cwd: workspace,
      sessionId: agent.getSessionId(),
      permissionMode: "bypassPermissions",
    });

    expect(result.toolResults[0]?.toolCall.name).toBe("run_shell");
    expect(result.toolResults[0]?.result.ok).toBe(false);
    if (result.toolResults[0] && !result.toolResults[0].result.ok) {
      expect(result.toolResults[0].result.error.code).toBe("PermissionDenied");
    }
  });

  it("runs fork skills in an isolated context", async () => {
    const provider = new FinalOnlyProvider();
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 1 });
    const before = agent.getMessages();
    const skill = createSkill({ mode: "fork" });

    const result = await runSkill({
      skill,
      args: "summarize",
      agent,
      provider,
      cwd: workspace,
      sessionId: agent.getSessionId(),
      permissionMode: "default",
    });

    expect(result.content).toBe("skill done");
    expect(agent.getMessages()).toEqual(before);
  });

  it("exposes skill summaries through agent system prompt", async () => {
    const provider = new FinalOnlyProvider();
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 1,
      skills: [createSkill({ mode: "inline" })],
    });

    await agent.run("hello");

    expect(provider.requests[0]?.messages[0]?.content).toContain(
      "Available skills:",
    );
    expect(provider.requests[0]?.messages[0]?.content).toContain("demo");
  });
});

function createSkill(input: Partial<Skill>): Skill {
  return {
    name: "demo",
    description: "Demo skill",
    mode: "inline",
    path: ".agent/skills/demo/SKILL.md",
    content: "Follow the demo instructions.",
    ...input,
  };
}

class DisallowedToolThenFinalProvider implements ModelProvider {
  readonly name = "disallowed-tool";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private calls = 0;

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      expect(input.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
      return {
        content: "",
        toolCalls: [
          {
            id: "call_shell",
            name: "run_shell",
            input: { command: "node --version" },
            rawArguments: JSON.stringify({ command: "node --version" }),
          },
        ],
      };
    }

    return { content: "done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}

class FinalOnlyProvider implements ModelProvider {
  readonly name = "final-only";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  readonly requests: ModelRequest[] = [];

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    return { content: "skill done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "unused", toolCalls: [] },
    };
  }
}
