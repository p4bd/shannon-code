import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ConfigError, ProviderError } from "./errors.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
} from "./model-provider.js";

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

const DEFAULT_MODEL = "gpt-4.1-mini";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = "openai-compatible";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = true;
  readonly supportsPromptCaching = false;

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) {
      throw new ConfigError(
        "Missing OPENAI_API_KEY. Create a .env file or set OPENAI_API_KEY in your shell.",
      );
    }

    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async createMessage(input: ModelRequest): Promise<ModelResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: input.messages.map(toOpenAIMessage),
        tools: input.tools?.map(toOpenAITool),
        tool_choice: input.tools && input.tools.length > 0 ? "auto" : undefined,
        temperature: input.temperature,
        max_tokens: input.maxOutputTokens,
      }, { signal: input.signal }) as unknown;

      if (!isChatCompletion(completion)) {
        throw new ProviderError(
          `Model provider returned an invalid chat completion response: ${summarizeInvalidResponse(completion)}`,
        );
      }

      return normalizeChatCompletion(completion);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(formatProviderError(error), { cause: error });
    }
  }

  async *createMessageStream(
    input: ModelRequest,
  ): AsyncIterable<ModelStreamEvent> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: input.messages.map(toOpenAIMessage),
        tools: input.tools?.map(toOpenAITool),
        tool_choice: input.tools && input.tools.length > 0 ? "auto" : undefined,
        temperature: input.temperature,
        max_tokens: input.maxOutputTokens,
        stream: true,
      }, { signal: input.signal });

      let content = "";
      let stopReason: string | undefined;
      const toolCallDeltas = new Map<
        number,
        {
          id: string;
          name: string;
          arguments: string;
        }
      >();
      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          stopReason = choice.finish_reason ?? stopReason;
          const delta = choice.delta.content ?? "";
          if (delta.length > 0) {
            content += delta;
            yield { type: "text_delta", delta };
          }

          for (const toolCallDelta of choice.delta.tool_calls ?? []) {
            const index = toolCallDelta.index;
            const existing =
              toolCallDeltas.get(index) ??
              ({
                id: "",
                name: "",
                arguments: "",
              } satisfies { id: string; name: string; arguments: string });

            if (toolCallDelta.id) {
              existing.id = toolCallDelta.id;
            }
            const functionDelta =
              "function" in toolCallDelta ? toolCallDelta.function : undefined;
            if (functionDelta?.name) {
              existing.name += functionDelta.name;
            }
            if (functionDelta?.arguments) {
              existing.arguments += functionDelta.arguments;
            }

            toolCallDeltas.set(index, existing);
          }
        }
      }

      const toolCalls = [...toolCallDeltas.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall], index) => ({
          id: toolCall.id || `stream_tool_call_${index}`,
          name: toolCall.name,
          input: parseToolArguments(toolCall.arguments),
          rawArguments: toolCall.arguments,
        }))
        .filter((toolCall) => toolCall.name.length > 0);

      yield { type: "done", response: { content, toolCalls, stopReason } };
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(formatProviderError(error), { cause: error });
    }
  }
}

function toOpenAIMessage(message: ModelMessage): ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? "unknown_tool_call",
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.rawArguments,
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content,
    name: message.name,
  } as ChatCompletionMessageParam;
}

function toOpenAITool(tool: ModelToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

function normalizeChatCompletion(completion: ChatCompletion): ModelResponse {
  const message = completion.choices[0]?.message;
  const content = message?.content;
  return {
    content: Array.isArray(content)
      ? content.map((part) => ("text" in part ? part.text : "")).join("")
      : (content ?? ""),
    toolCalls:
      message?.tool_calls?.flatMap((toolCall) => {
        if (toolCall.type !== "function") {
          return [];
        }

        return [
          {
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolArguments(toolCall.function.arguments),
            rawArguments: toolCall.function.arguments,
          },
        ];
      }) ?? [],
    stopReason: completion.choices[0]?.finish_reason ?? undefined,
    raw: completion,
  };
}

function isChatCompletion(value: unknown): value is ChatCompletion {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { choices?: unknown }).choices)
  );
}

function summarizeInvalidResponse(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.slice(0, 120));
  }

  if (value && typeof value === "object") {
    return `object keys: ${Object.keys(value).slice(0, 12).join(", ") || "(none)"}`;
  }

  return String(value);
}

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

function formatProviderError(error: unknown): string {
  if (error instanceof Error) {
    return `Model provider request failed: ${error.message}`;
  }

  return "Model provider request failed with a non-Error value.";
}
