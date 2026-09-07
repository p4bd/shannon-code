import { agentTool } from "./agent.tool.js";
import { editFileTool } from "./edit-file.tool.js";
import { grepSearchTool } from "./grep-search.tool.js";
import { listFilesTool } from "./list-files.tool.js";
import { readFileTool } from "./read-file.tool.js";
import { ToolRegistry } from "./registry.js";
import { runShellTool } from "./run-shell.tool.js";
import { toolSearchTool } from "./tool-search.tool.js";
import { webFetchTool } from "./web-fetch.tool.js";
import { writeFileTool } from "./write-file.tool.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listFilesTool);
  registry.register(grepSearchTool);
  registry.register(runShellTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(webFetchTool);
  registry.register(toolSearchTool);
  registry.register(agentTool);
  return registry;
}
