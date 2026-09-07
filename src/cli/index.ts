#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, USAGE } from "./args.js";
import {
  createConsoleEventRenderer,
  formatAgentMessage,
  formatErrorMessage,
} from "./render.js";
import { startRepl } from "./repl.js";
import { Agent } from "../core/agent.js";
import { ConfigError, ProviderError } from "../core/errors.js";
import { OpenAICompatibleProvider } from "../core/openai-provider.js";
import { loadHookConfig } from "../hooks/config.js";
import { HookRunner } from "../hooks/runner.js";
import {
  loadTypeScriptDiagnosticsConfig,
  TypeScriptDiagnosticsRunner,
} from "../lsp/typescript-diagnostics.js";
import { MemoryStore } from "../memory/store.js";
import { McpManager } from "../mcp/manager.js";
import { loadProjectRules } from "../prompt/project-rules.js";
import { loadSkills } from "../skills/loader.js";
import { LocalSubagentRunner } from "../subagent/runner.js";
import type { SerializedSession } from "../session/serializer.js";
import { SessionStore } from "../session/store.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { loadDotEnv } from "../utils/env.js";
import { ConsoleLogger } from "../utils/logger.js";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (args.version) {
    console.log(await readPackageVersion());
    return;
  }

  await loadDotEnv(cwd);

  const provider = new OpenAICompatibleProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: emptyToUndefined(process.env.OPENAI_BASE_URL),
    model: emptyToUndefined(process.env.OPENAI_MODEL),
  });
  const sessionStore = new SessionStore(cwd);
  const memoryStore = new MemoryStore(cwd);
  const projectRules = await loadProjectRules(cwd);
  const skills = await loadSkills(cwd);
  const logger = new ConsoleLogger();
  const hookRunner = new HookRunner(await loadHookConfig(cwd), logger);
  const diagnosticsRunner = new TypeScriptDiagnosticsRunner(
    await loadTypeScriptDiagnosticsConfig(cwd),
    logger,
  );
  const registry = createDefaultToolRegistry();
  const mcpManager = await McpManager.load(cwd, logger);
  await mcpManager?.registerTools(registry);
  const subagentRunner = new LocalSubagentRunner({
    provider,
    cwd,
    projectRules,
    memoryStore,
    skills,
    registry,
    logger,
    hookRunner,
    diagnosticsRunner,
  });
  const initialSession = await resolveInitialSession(sessionStore, args.resume);
  const sessionId =
    initialSession?.metadata.sessionId ?? sessionStore.createSessionId();

  try {
    if (!args.prompt) {
      await startRepl({
        cwd,
        provider,
        model: provider.model,
        sessionStore,
        initialSession,
        sessionId,
        permissionMode: args.permissionMode,
        maxTurns: args.maxTurns,
        projectRules,
        memoryStore,
        skills,
        subagentRunner,
        registry,
        hookRunner,
        diagnosticsRunner,
      });
      return;
    }

    console.log(`Workspace: ${cwd}`);

    const agent = new Agent({
      provider,
      registry,
      cwd,
      sessionId,
      initialMessages: initialSession?.messages,
      permissionMode: args.permissionMode,
      maxTurns: args.maxTurns,
      projectRules,
      memoryStore,
      skills,
      subagentRunner,
      hookRunner,
      diagnosticsRunner,
      logger,
    });

    const renderer = createConsoleEventRenderer();
    const result = await agent.run(args.prompt, { onEvent: renderer.onEvent });
    renderer.finish();
    await sessionStore.saveSession({
      sessionId: agent.getSessionId(),
      messages: agent.getMessages(),
    });
    if (!provider.supportsStreaming) {
      console.log(formatAgentMessage(result.content));
    }
  } finally {
    await mcpManager?.stopAll();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof ProviderError) {
    console.error(formatErrorMessage(error.message));
    process.exitCode = 1;
    return;
  }

  if (error instanceof Error) {
    console.error(formatErrorMessage(`Unexpected error: ${error.message}`));
  } else {
    console.error(formatErrorMessage("Unexpected non-Error thrown."));
  }
  process.exitCode = 1;
});

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

async function readPackageVersion(): Promise<string> {
  const currentFile = fileURLToPath(import.meta.url);
  const packageJsonPath = resolve(dirname(currentFile), "../../package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

async function resolveInitialSession(
  sessionStore: SessionStore,
  resume: true | string | undefined,
): Promise<SerializedSession | undefined> {
  if (!resume) {
    return undefined;
  }

  if (resume === true) {
    return sessionStore.loadLatestSession();
  }

  return sessionStore.loadSession(resume);
}
