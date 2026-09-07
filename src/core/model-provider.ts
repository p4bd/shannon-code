export type ModelRole = "system" | "user" | "assistant" | "tool";

export type JsonSchema = {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema | Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema | Record<string, unknown>;
  enum?: string[];
  [key: string]: unknown;
};

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
  rawArguments: string;
}

export interface ModelPromptSection {
  name: string;
  content: string;
  cacheable: boolean;
}

export interface ModelPromptCacheControl {
  type: "ephemeral";
  key: string;
  sectionNames: string[];
}

export interface ModelMessage {
  role: ModelRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  promptSections?: ModelPromptSection[];
  cacheControl?: ModelPromptCacheControl;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string;
  toolCalls: ModelToolCall[];
  stopReason?: string;
  raw?: unknown;
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; response: ModelResponse };

export interface ModelProvider {
  name: string;
  supportsToolCalling: boolean;
  supportsStreaming: boolean;
  supportsPromptCaching: boolean;

  createMessage(input: ModelRequest): Promise<ModelResponse>;
  createMessageStream(input: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
