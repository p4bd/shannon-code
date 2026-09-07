import { z } from "zod";
import { fail } from "./result.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";

const agentInput = z.object({
  agentType: z.string().min(1).describe("Sub-agent type, such as explore, plan, general, or a custom .agent/agents name."),
  prompt: z.string().min(1).describe("Task for the sub-agent."),
  maxTurns: z.number().int().positive().max(20).optional().describe("Optional maximum turns for the sub-agent."),
});

type AgentInput = z.infer<typeof agentInput>;

export const agentTool: Tool<AgentInput> = {
  name: "agent",
  description:
    "Delegate a task to a forked sub-agent. Built-in agent types include explore, plan, and general.",
  inputSchema: jsonSchema(agentInput),
  inputValidator: agentInput,
  safety: "execute",
  readOnly: false,
  requiresApproval: false,
  async execute(input, ctx) {
    if (!ctx.subagentRunner) {
      return fail({
        code: "UnknownError",
        message: "Sub-agent runner is not configured.",
        content: "The agent tool is unavailable because no sub-agent runner was configured.",
        recoverable: true,
      });
    }

    return ctx.subagentRunner.run({
      agentType: input.agentType,
      prompt: input.prompt,
      maxTurns: input.maxTurns,
      parentSessionId: ctx.sessionId,
      depth: ctx.subagentDepth,
      signal: ctx.abortSignal,
    });
  },
};
