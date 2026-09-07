import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/core/model-provider.js";

describe("prompt caching", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-prompt-cache-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("does not add cache metadata for providers without prompt caching", async () => {
    const provider = new CaptureProvider(false);
    const agent = new Agent({ provider, cwd: workspace, maxTurns: 1 });

    await agent.run("hello");

    const system = provider.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("You are Shannon Code");
    expect(system?.cacheControl).toBeUndefined();
    expect(system?.promptSections).toBeUndefined();
  });

  it("marks static prompt sections for providers that support prompt caching", async () => {
    const provider = new CaptureProvider(true);
    const agent = new Agent({
      provider,
      cwd: workspace,
      maxTurns: 1,
      skills: [
        {
          name: "commit",
          description: "Commit helper",
          mode: "inline",
          path: ".agent/skills/commit/SKILL.md",
          allowedTools: ["read_file"],
          content: "Draft commit text.",
        },
      ],
    });

    await agent.run("hello");

    const system = provider.requests[0]?.messages[0];
    expect(system?.cacheControl).toMatchObject({
      type: "ephemeral",
      sectionNames: ["agent_core", "skills"],
    });
    expect(system?.cacheControl?.key).toMatch(/^[a-f0-9]{64}$/);
    expect(system?.promptSections?.filter((section) => section.cacheable).map(
      (section) => section.name,
    )).toEqual(["agent_core", "skills"]);
    expect(system?.promptSections?.find((section) => section.name === "workspace")?.cacheable).toBe(
      false,
    );
  });
});

class CaptureProvider implements ModelProvider {
  readonly name = "capture";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching: boolean;
  readonly requests: ModelRequest[] = [];

  constructor(supportsPromptCaching: boolean) {
    this.supportsPromptCaching = supportsPromptCaching;
  }

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(cloneRequest(input));
    return { content: "done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

function cloneRequest(input: ModelRequest): ModelRequest {
  return {
    ...input,
    messages: input.messages.map((message) => cloneMessage(message)),
    tools: input.tools?.map((tool) => ({ ...tool })),
  };
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    promptSections: message.promptSections?.map((section) => ({ ...section })),
    cacheControl: message.cacheControl
      ? {
          ...message.cacheControl,
          sectionNames: [...message.cacheControl.sectionNames],
        }
      : undefined,
  };
}

