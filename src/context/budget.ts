import type { ModelMessage } from "../core/model-provider.js";
import { estimateMessagesTokens } from "./token-estimator.js";

export interface ContextBudgetOptions {
  maxEstimatedTokens: number;
  autoCompactThreshold: number;
  recentMessages: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetOptions = {
  maxEstimatedTokens: 24_000,
  autoCompactThreshold: 0.8,
  recentMessages: 12,
};

export interface ContextBudgetStatus {
  estimatedTokens: number;
  maxEstimatedTokens: number;
  thresholdTokens: number;
  shouldCompact: boolean;
}

export function getContextBudgetStatus(
  messages: ModelMessage[],
  options: ContextBudgetOptions = DEFAULT_CONTEXT_BUDGET,
): ContextBudgetStatus {
  const estimatedTokens = estimateMessagesTokens(messages);
  const thresholdTokens = Math.floor(
    options.maxEstimatedTokens * options.autoCompactThreshold,
  );

  return {
    estimatedTokens,
    maxEstimatedTokens: options.maxEstimatedTokens,
    thresholdTokens,
    shouldCompact: estimatedTokens >= thresholdTokens,
  };
}
