import type { ModelMessage } from "../core/model-provider.js";

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: ModelMessage): number {
  const toolCallTokens =
    message.toolCalls?.reduce(
      (sum, toolCall) =>
        sum +
        estimateTextTokens(toolCall.name) +
        estimateTextTokens(toolCall.rawArguments),
      0,
    ) ?? 0;

  return 4 + estimateTextTokens(message.role) + estimateTextTokens(message.content) + toolCallTokens;
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
}
