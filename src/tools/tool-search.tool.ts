import { z } from "zod";
import { agentTool } from "./agent.tool.js";
import { editFileTool } from "./edit-file.tool.js";
import { grepSearchTool } from "./grep-search.tool.js";
import { listFilesTool } from "./list-files.tool.js";
import { readFileTool } from "./read-file.tool.js";
import { ok } from "./result.js";
import { runShellTool } from "./run-shell.tool.js";
import { jsonSchema } from "./schema.js";
import type { Tool } from "./types.js";
import { webFetchTool } from "./web-fetch.tool.js";
import { writeFileTool } from "./write-file.tool.js";

const toolSearchInput = z.object({
  query: z.string().min(1).describe("Tool name or keyword to search for."),
});

type ToolSearchInput = z.infer<typeof toolSearchInput>;

const searchableTools = [
  readFileTool,
  listFilesTool,
  grepSearchTool,
  runShellTool,
  writeFileTool,
  editFileTool,
  webFetchTool,
  agentTool,
];

export const toolSearchTool: Tool<ToolSearchInput> = {
  name: "tool_search",
  description:
    "Search available Shannon tools by name or description and return their schemas.",
  inputSchema: jsonSchema(toolSearchInput),
  inputValidator: toolSearchInput,
  safety: "read",
  readOnly: true,
  requiresApproval: false,
  async execute(input) {
    const query = input.query.toLowerCase();
    const matches = searchableTools.filter((tool) =>
      `${tool.name} ${tool.description}`.toLowerCase().includes(query),
    );
    const selected = matches.length > 0 ? matches : searchableTools;

    return ok(JSON.stringify(selected.map(toSearchResult), null, 2), {
      query: input.query,
      matches: selected.length,
    });
  },
};

function toSearchResult(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    safety: tool.safety,
    readOnly: tool.readOnly,
    requiresApproval: tool.requiresApproval,
    inputSchema: tool.inputSchema,
  };
}
