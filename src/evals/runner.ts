import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Agent, type AgentRunResult } from "../core/agent.js";
import type { ModelProvider } from "../core/model-provider.js";
import { OpenAICompatibleProvider } from "../core/openai-provider.js";
import { HookRunner } from "../hooks/runner.js";
import { McpManager } from "../mcp/manager.js";
import { MemoryStore } from "../memory/store.js";
import { TypeScriptDiagnosticsRunner } from "../lsp/typescript-diagnostics.js";
import type { PermissionMode } from "../permissions/modes.js";
import { loadProjectRules } from "../prompt/project-rules.js";
import { loadSkills } from "../skills/loader.js";
import { runSkill } from "../skills/runner.js";
import { LocalSubagentRunner } from "../subagent/runner.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { loadDotEnv } from "../utils/env.js";
import { NoopLogger } from "../utils/logger.js";
import {
  expandGeneratedFile,
  loadEvalCases,
  type EvalCase,
} from "./case.js";
import {
  runEvalAssertions,
  type EvalAssertionResult,
} from "./assertions.js";
import { ScriptedEvalProvider } from "./mock-provider.js";

export interface EvalRunOptions {
  projectRoot: string;
  casesDir?: string;
  outputJsonPath?: string;
  outputMarkdownPath?: string;
  useRealProvider?: boolean;
  keepWorkspaces?: boolean;
}

export interface EvalSuiteResult {
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  cases: EvalCaseResult[];
}

export interface EvalCaseResult {
  name: string;
  passed: boolean;
  durationMs: number;
  workspace: string;
  content: string;
  toolCalls: string[];
  assertions: EvalAssertionResult[];
  error?: string;
}

export async function runEvalSuite(
  options: EvalRunOptions,
): Promise<EvalSuiteResult> {
  const startedAt = new Date().toISOString();
  const casesDir = options.casesDir ?? resolve(options.projectRoot, "evals", "cases");
  const cases = await loadEvalCases(casesDir);
  const tempRoot = await mkdtemp(join(tmpdir(), "shannon-evals-"));
  const results: EvalCaseResult[] = [];

  try {
    for (const evalCase of cases) {
      results.push(
        await runEvalCase({
          evalCase,
          projectRoot: options.projectRoot,
          tempRoot,
          useRealProvider: options.useRealProvider ?? false,
        }),
      );
    }
  } finally {
    if (!options.keepWorkspaces) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  const finishedAt = new Date().toISOString();
  const passedCount = results.filter((result) => result.passed).length;
  const suite: EvalSuiteResult = {
    startedAt,
    finishedAt,
    passed: passedCount === results.length,
    total: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    cases: results,
  };

  await writeReports({
    suite,
    outputJsonPath:
      options.outputJsonPath ?? resolve(options.projectRoot, "eval-report.json"),
    outputMarkdownPath:
      options.outputMarkdownPath ?? resolve(options.projectRoot, "eval-report.md"),
  });

  return suite;
}

async function runEvalCase(input: {
  evalCase: EvalCase;
  projectRoot: string;
  tempRoot: string;
  useRealProvider: boolean;
}): Promise<EvalCaseResult> {
  const started = Date.now();
  const workspace = join(input.tempRoot, sanitizeName(input.evalCase.name));
  await mkdir(workspace, { recursive: true });

  try {
    await prepareWorkspace({
      evalCase: input.evalCase,
      workspace,
      projectRoot: input.projectRoot,
    });

    const result = await runCaseAgent({
      evalCase: input.evalCase,
      workspace,
      projectRoot: input.projectRoot,
      useRealProvider: input.useRealProvider,
    });
    const assertions = await runEvalAssertions({
      assertions: input.evalCase.assertions,
      context: { cwd: workspace, result },
    });
    const passed = assertions.every((assertion) => assertion.passed);

    return {
      name: input.evalCase.name,
      passed,
      durationMs: Date.now() - started,
      workspace,
      content: result.content,
      toolCalls: result.toolResults.map((entry) => entry.toolCall.name),
      assertions,
    };
  } catch (error) {
    return {
      name: input.evalCase.name,
      passed: false,
      durationMs: Date.now() - started,
      workspace,
      content: "",
      toolCalls: [],
      assertions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCaseAgent(input: {
  evalCase: EvalCase;
  workspace: string;
  projectRoot: string;
  useRealProvider: boolean;
}): Promise<AgentRunResult> {
  const logger = new NoopLogger();
  const provider = await createProvider(input);
  const registry = createDefaultToolRegistry();
  let mcpManager: McpManager | undefined;
  if (input.evalCase.mcpTestServer) {
    mcpManager = await McpManager.load(input.workspace, logger);
    await mcpManager?.registerTools(registry);
  }

  const projectRules = await loadProjectRules(input.workspace);
  const memoryStore = new MemoryStore(input.workspace);
  const skills = await loadSkills(input.workspace);
  const hookRunner = new HookRunner({ hooks: [] }, logger);
  const diagnosticsRunner = new TypeScriptDiagnosticsRunner(
    {
      enabled: false,
      command: "npx",
      args: ["tsc", "--noEmit"],
      timeoutMs: 30_000,
      maxDiagnostics: 50,
    },
    logger,
  );
  const subagentRunner = new LocalSubagentRunner({
    provider,
    cwd: input.workspace,
    projectRules,
    memoryStore,
    skills,
    registry,
    logger,
    hookRunner,
    diagnosticsRunner,
    defaultMaxTurns: 2,
  });

  const agent = new Agent({
    provider,
    registry,
    cwd: input.workspace,
    initialMessages: input.evalCase.initialMessages,
    permissionMode: input.evalCase.permissionMode,
    maxTurns: input.evalCase.maxTurns,
    projectRules,
    memoryStore,
    skills,
    subagentRunner,
    hookRunner,
    diagnosticsRunner,
    logger,
  });

  try {
    if (input.evalCase.skillName) {
      const skill = skills.find((candidate) => candidate.name === input.evalCase.skillName);
      if (!skill) {
        throw new Error(`Skill not found for eval: ${input.evalCase.skillName}`);
      }

      return await runSkill({
        skill,
        args: input.evalCase.skillArgs ?? "",
        agent,
        provider,
        cwd: input.workspace,
        sessionId: agent.getSessionId(),
        permissionMode: agent.getPermissionMode(),
        registry,
        projectRules,
        memoryStore,
        skills,
        maxTurns: input.evalCase.maxTurns,
        hookRunner,
        diagnosticsRunner,
        logger,
      });
    }

    return await agent.run(input.evalCase.prompt);
  } finally {
    await mcpManager?.stopAll();
  }
}

async function createProvider(input: {
  evalCase: EvalCase;
  projectRoot: string;
  useRealProvider: boolean;
}): Promise<ModelProvider> {
  if (input.useRealProvider || input.evalCase.mode === "real") {
    await loadDotEnv(input.projectRoot);
    return new OpenAICompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: emptyToUndefined(process.env.OPENAI_BASE_URL),
      model: emptyToUndefined(process.env.OPENAI_MODEL),
    });
  }

  if (!input.evalCase.mock) {
    throw new Error(`Eval case requires mock config: ${input.evalCase.name}`);
  }

  return new ScriptedEvalProvider(input.evalCase.mock);
}

async function prepareWorkspace(input: {
  evalCase: EvalCase;
  workspace: string;
  projectRoot: string;
}): Promise<void> {
  for (const [path, content] of Object.entries(input.evalCase.workspace.files)) {
    const absolutePath = resolve(input.workspace, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, expandGeneratedFile(content), "utf8");
  }

  if (input.evalCase.mcpTestServer) {
    const mcpConfigPath = resolve(input.workspace, ".agent", "mcp.json");
    await mkdir(dirname(mcpConfigPath), { recursive: true });
    await writeFile(
      mcpConfigPath,
      JSON.stringify(
        {
          servers: {
            test: {
              command: process.execPath,
              args: [resolve(input.projectRoot, "tests", "fixtures", "mcp-test-server.mjs")],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

async function writeReports(input: {
  suite: EvalSuiteResult;
  outputJsonPath: string;
  outputMarkdownPath: string;
}): Promise<void> {
  await writeFile(input.outputJsonPath, `${JSON.stringify(input.suite, null, 2)}\n`, "utf8");
  await writeFile(input.outputMarkdownPath, formatMarkdownReport(input.suite), "utf8");
}

export function formatMarkdownReport(suite: EvalSuiteResult): string {
  const lines = [
    "# Eval Report",
    "",
    `Started: ${suite.startedAt}`,
    `Finished: ${suite.finishedAt}`,
    `Result: ${suite.passed ? "PASS" : "FAIL"} (${suite.passedCount}/${suite.total})`,
    "",
    "| Case | Result | Duration | Tools |",
    "| --- | --- | ---: | --- |",
    ...suite.cases.map(
      (entry) =>
        `| ${escapeMarkdown(entry.name)} | ${entry.passed ? "PASS" : "FAIL"} | ${entry.durationMs}ms | ${escapeMarkdown(entry.toolCalls.join(", ") || "-")} |`,
    ),
    "",
  ];

  for (const entry of suite.cases) {
    lines.push(`## ${entry.passed ? "PASS" : "FAIL"} ${entry.name}`);
    if (entry.error) {
      lines.push("", `Error: ${entry.error}`);
    }
    lines.push("", "Assertions:");
    if (entry.assertions.length === 0) {
      lines.push("- No assertions ran.");
    } else {
      lines.push(
        ...entry.assertions.map(
          (assertion) =>
            `- ${assertion.passed ? "PASS" : "FAIL"} ${assertion.type}: ${assertion.message}`,
        ),
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
