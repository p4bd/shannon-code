import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
} from "../core/model-provider.js";
import type { EvalMockConfig } from "./case.js";

export class ScriptedEvalProvider implements ModelProvider {
  readonly name = "scripted-eval";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching: boolean;
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly config: EvalMockConfig) {
    this.supportsPromptCaching = config.supportsPromptCaching;
  }

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(cloneRequest(input));
    const step = this.config.steps[this.index];
    this.index += 1;

    if (!step) {
      return { content: "No scripted eval step remained.", toolCalls: [] };
    }

    return {
      content: step.content ?? "",
      toolCalls:
        step.toolCalls?.map((toolCall, toolIndex) => ({
          id: `eval_call_${this.index}_${toolIndex}_${toolCall.name}`,
          name: toolCall.name,
          input: toolCall.input,
          rawArguments: JSON.stringify(toolCall.input ?? {}),
        })) ?? [],
    };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "done",
      response: { content: "Scripted eval provider does not stream.", toolCalls: [] },
    };
  }
}

function cloneRequest(input: ModelRequest): ModelRequest {
  return {
    ...input,
    messages: input.messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map(cloneToolCall),
      promptSections: message.promptSections?.map((section) => ({ ...section })),
      cacheControl: message.cacheControl
        ? {
            ...message.cacheControl,
            sectionNames: [...message.cacheControl.sectionNames],
          }
        : undefined,
    })),
    tools: input.tools?.map((tool) => ({ ...tool })),
  };
}

function cloneToolCall(toolCall: ModelToolCall): ModelToolCall {
  return { ...toolCall };
}

