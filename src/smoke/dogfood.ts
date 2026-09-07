#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadDotEnv } from "../utils/env.js";

const projectRoot = process.cwd();
await loadDotEnv(projectRoot, { override: true });

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY.");
}

type FindingKind = "bug" | "ux" | "variance" | "info";

interface Finding {
  kind: FindingKind;
  message: string;
}

interface CaseResult {
  name: string;
  category: string;
  passed: boolean;
  durationMs: number;
  workspace: string;
  stdout: string;
  stderr: string;
  checks: Record<string, boolean>;
  findings: Finding[];
  error?: string;
}

interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface DogfoodSummary {
  startedAt: string;
  passed: boolean;
  repeatCount: number;
  retainedWorkspaces: boolean;
  tempRoot: string;
  model: string;
  baseURL: string;
  cases: CaseResult[];
}

const reportPath = resolve(projectRoot, "dogfood-report.json");
const reportMarkdownPath = resolve(projectRoot, "DOGFOOD_REPORT.md");
const tempRoot = resolve(tmpdir(), `shannon-dogfood-${process.pid}`);
const repeatCount = parseRepeatCount(process.env.DOGFOOD_REPEAT);
const cases: CaseResult[] = [];

await rm(tempRoot, { recursive: true, force: true });
await mkdir(tempRoot, { recursive: true });

for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
  cases.push(await runCodeRepairCase(iteration));
  cases.push(await runMissingFileRecoveryCase(iteration));
  cases.push(await runEditErrorRecoveryCase(iteration));
  cases.push(await runLargeOutputArtifactCase(iteration));
  cases.push(await runMcpAddCase(iteration));
  cases.push(await runHookDenyCase(iteration));
  cases.push(await runPlanModeCase(iteration));
  cases.push(await runAcceptEditsCase(iteration));
  cases.push(await runDontAskDenyCase(iteration));
  cases.push(await runSkillCase(iteration));
  cases.push(await runWebFetchCase(iteration));
  cases.push(await runUnicodePathCase(iteration));
  cases.push(await runResumeCase(iteration));
}

const passed = cases.every((result) => result.passed);
const retainedWorkspaces = process.env.DOGFOOD_KEEP_WORKSPACE === "1" || !passed;
const summary: DogfoodSummary = {
  startedAt: new Date().toISOString(),
  passed,
  repeatCount,
  retainedWorkspaces,
  tempRoot,
  model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  baseURL: process.env.OPENAI_BASE_URL ? "[configured]" : "[default]",
  cases,
};

await writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8");
await writeFile(reportMarkdownPath, formatMarkdownReport(summary), "utf8");

if (!retainedWorkspaces) {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(
  `DOGFOOD ${passed ? "PASS" : "FAIL"}: ${
    cases.filter((result) => result.passed).length
  }/${cases.length} cases passed.`,
);
console.log(`Reports: ${reportPath}, ${reportMarkdownPath}`);
console.log(
  retainedWorkspaces
    ? `Workspaces retained at: ${tempRoot}`
    : "Temporary workspaces cleaned up.",
);

if (!passed) {
  process.exitCode = 1;
}

async function runCodeRepairCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "repairs a small project after a failing test");
  const workspace = workspaceFor(iteration, "code-repair");
  const started = performance.now();
  try {
    await writeWorkspaceFile(
      workspace,
      "package.json",
      JSON.stringify({ scripts: { test: "node test.mjs" } }, null, 2),
    );
    await writeWorkspaceFile(
      workspace,
      "src/math.ts",
      [
        "export function add(a: number, b: number): number {",
        "  return a - b;",
        "}",
        "",
      ].join("\n"),
    );
    await writeWorkspaceFile(
      workspace,
      "test.mjs",
      [
        'import { readFileSync } from "node:fs";',
        'const text = readFileSync("src/math.ts", "utf8");',
        'if (!/return\\s+a\\s*\\+\\s*b/.test(text)) {',
        '  console.error("expected add to return a + b");',
        "  process.exit(1);",
        "}",
        'console.log("DOGFOOD_CODE_TEST_PASS");',
        "",
      ].join("\n"),
    );

    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "This is a dogfood coding task.",
        "Inspect the project, run npm test, fix src/math.ts so the test passes,",
        "run npm test again, then answer exactly DOGFOOD_CODE_REPAIR_OK.",
        "Use the smallest file edit that solves the failing test.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 10,
      timeoutMs: 240_000,
    });
    const math = await readIfExists(resolve(workspace, "src/math.ts"));
    const checks = {
      exited: result.code === 0,
      usedShell: result.stdout.includes("[tool] run_shell"),
      sawFailingTest: result.stdout.includes("expected add to return a + b"),
      sawPassingTest: result.stdout.includes("DOGFOOD_CODE_TEST_PASS"),
      fixedFile: /return\s+a\s*\+\s*b/.test(math),
      finalMarker: result.stdout.includes("DOGFOOD_CODE_REPAIR_OK"),
    };

    return completeCase({
      name,
      category: "coding loop",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "usedShell", "sawPassingTest", "fixedFile"],
      findings: markerFinding(checks.finalMarker, "code repair final marker was missing"),
    });
  } catch (error) {
    return failedCase(name, "coding loop", workspace, started, error);
  }
}

async function runMissingFileRecoveryCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "recovers from a mistyped file path");
  const workspace = workspaceFor(iteration, "missing-file");
  const started = performance.now();
  try {
    await writeWorkspaceFile(
      workspace,
      "src/app.ts",
      'export const appName = "DOGFOOD_REAL_APP";\n',
    );
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "This is a dogfood recovery task.",
        "First try to read_file path src/ap.ts exactly; that typo is intentional.",
        "When it fails, recover by listing src and reading src/app.ts.",
        "Then answer exactly DOGFOOD_MISSING_FILE_OK and include DOGFOOD_REAL_APP.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 7,
      timeoutMs: 180_000,
    });
    const checks = {
      exited: result.code === 0,
      sawReadTool: result.stdout.includes("[tool] read_file"),
      sawMissingError:
        result.stdout.includes("FileNotFound") || result.stdout.includes("ENOENT"),
      usedListFiles: result.stdout.includes("[tool] list_files"),
      recoveredContent: result.stdout.includes("DOGFOOD_REAL_APP"),
      finalMarker: result.stdout.includes("DOGFOOD_MISSING_FILE_OK"),
    };

    return completeCase({
      name,
      category: "tool error recovery",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "sawMissingError", "usedListFiles", "recoveredContent"],
      findings: markerFinding(
        checks.finalMarker,
        "missing-file recovery final marker was missing",
      ),
    });
  } catch (error) {
    return failedCase(name, "tool error recovery", workspace, started, error);
  }
}

async function runEditErrorRecoveryCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "recovers after edit_file cannot find old text");
  const workspace = workspaceFor(iteration, "edit-error");
  const started = performance.now();
  try {
    await writeWorkspaceFile(workspace, "target.txt", "alpha\n");
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "This is a dogfood edit recovery task.",
        "Read target.txt first.",
        "Then deliberately call edit_file on target.txt replacing the exact old string gamma with delta.",
        "Do not skip that intentional failing edit.",
        "After the edit fails, recover by changing alpha to beta.",
        "Then answer exactly DOGFOOD_EDIT_RECOVERY_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 9,
      timeoutMs: 220_000,
    });
    const target = await readIfExists(resolve(workspace, "target.txt"));
    const checks = {
      exited: result.code === 0,
      readBeforeEdit: result.stdout.includes("[tool] read_file"),
      sawSearchMiss:
        result.stdout.includes("SearchStringNotFound") ||
        result.stdout.includes("Could not find exact text"),
      recoveredFile: target.trim() === "beta",
      finalMarker: result.stdout.includes("DOGFOOD_EDIT_RECOVERY_OK"),
    };

    return completeCase({
      name,
      category: "tool error recovery",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "readBeforeEdit", "sawSearchMiss", "recoveredFile"],
      findings: markerFinding(
        checks.finalMarker,
        "edit recovery final marker was missing",
      ),
    });
  } catch (error) {
    return failedCase(name, "tool error recovery", workspace, started, error);
  }
}

async function runLargeOutputArtifactCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "stores a large shell result as an artifact");
  const workspace = workspaceFor(iteration, "large-output");
  const started = performance.now();
  try {
    await mkdir(workspace, { recursive: true });
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Run this exact shell command:",
        'node -e "process.stdout.write(\'DOGFOOD_LONG_OUTPUT_START\\\\n\' + \'x\'.repeat(70000))"',
        "After the tool returns, answer exactly DOGFOOD_ARTIFACT_OK and mention the artifact path if one is shown.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 5,
      timeoutMs: 180_000,
    });
    const artifactFiles = await listArtifactFiles(workspace);
    const checks = {
      exited: result.code === 0,
      usedShell: result.stdout.includes("[tool] run_shell"),
      sawLargeResultNotice: result.stdout.includes("Tool result was too large"),
      wroteArtifact: artifactFiles.length > 0,
      finalMarker: result.stdout.includes("DOGFOOD_ARTIFACT_OK"),
    };

    return completeCase({
      name,
      category: "large result handling",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "usedShell", "sawLargeResultNotice", "wroteArtifact"],
      findings: markerFinding(
        checks.finalMarker,
        "artifact case final marker was missing",
      ),
    });
  } catch (error) {
    return failedCase(name, "large result handling", workspace, started, error);
  }
}

async function runMcpAddCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "uses a local MCP tool");
  const workspace = workspaceFor(iteration, "mcp-add");
  const started = performance.now();
  try {
    await writeWorkspaceFile(
      workspace,
      ".agent/mcp.json",
      JSON.stringify(
        {
          servers: {
            test: {
              command: process.execPath,
              args: [resolve(projectRoot, "tests", "fixtures", "mcp-test-server.mjs")],
            },
          },
        },
        null,
        2,
      ),
    );
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Use the MCP tool mcp__test__add to compute 19 + 23.",
        "After the tool returns, answer exactly DOGFOOD_MCP_OK and include the number 42.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 5,
      timeoutMs: 180_000,
    });
    const checks = {
      exited: result.code === 0,
      registeredMcp: result.stderr.includes("Registered MCP tools"),
      usedMcpAdd: result.stdout.includes("[tool] mcp__test__add"),
      sawAnswer: result.stdout.includes("42"),
      finalMarker: result.stdout.includes("DOGFOOD_MCP_OK"),
    };

    return completeCase({
      name,
      category: "mcp",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "registeredMcp", "usedMcpAdd", "sawAnswer"],
      findings: markerFinding(checks.finalMarker, "MCP final marker was missing"),
    });
  } catch (error) {
    return failedCase(name, "mcp", workspace, started, error);
  }
}

async function runHookDenyCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "surfaces a PreToolUse hook denial");
  const workspace = workspaceFor(iteration, "hook-deny");
  const started = performance.now();
  try {
    await writeWorkspaceFile(
      workspace,
      ".agent/hooks.json",
      JSON.stringify(
        {
          hooks: [
            {
              event: "PreToolUse",
              matcher: "run_shell",
              command: process.execPath,
              args: [
                resolve(projectRoot, "tests", "fixtures", "hook-fixture.mjs"),
                "deny-run-shell",
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Use run_shell to run node --version.",
        "If the hook blocks the tool, do not retry run_shell.",
        "Answer exactly DOGFOOD_HOOK_DENIED_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 5,
      timeoutMs: 150_000,
    });
    const checks = {
      exited: result.code === 0,
      attemptedShell: result.stdout.includes("[tool] run_shell"),
      sawHookDenied: result.stdout.includes("HookDenied"),
      sawReason: result.stdout.includes("run_shell is blocked by hook"),
      finalMarker: result.stdout.includes("DOGFOOD_HOOK_DENIED_OK"),
    };

    return completeCase({
      name,
      category: "hooks",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "attemptedShell", "sawHookDenied", "sawReason"],
      findings: markerFinding(checks.finalMarker, "hook final marker was missing"),
    });
  } catch (error) {
    return failedCase(name, "hooks", workspace, started, error);
  }
}

async function runPlanModeCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "plans then executes after approval");
  const workspace = workspaceFor(iteration, "plan-mode");
  const started = performance.now();
  try {
    await mkdir(workspace, { recursive: true });
    const result = await runShannonScriptedRepl({
      cwd: workspace,
      lines: [
        [
          "/plan Create a file named planned-dogfood.txt with the exact content plan-dogfood.",
          "The execution must use write_file.",
          "After execution, the final answer must include DOGFOOD_PLAN_OK.",
        ].join(" "),
        "/plan approve",
      ],
      approvalAnswer: "a",
      maxTurns: 8,
      timeoutMs: 220_000,
    });
    const planned = await readIfExists(resolve(workspace, "planned-dogfood.txt"));
    const checks = {
      exited: result.code === 0,
      planSaved: result.stdout.includes("Plan saved to"),
      sawApproval: result.stdout.includes("Permission request: write_file"),
      executedPlan: result.stdout.includes("Executed plan"),
      wroteFile: planned.includes("plan-dogfood"),
      finalMarker: result.stdout.includes("DOGFOOD_PLAN_OK"),
    };

    return completeCase({
      name,
      category: "plan mode",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "planSaved", "sawApproval", "executedPlan", "wroteFile"],
      findings: markerFinding(checks.finalMarker, "plan final marker was missing"),
    });
  } catch (error) {
    return failedCase(name, "plan mode", workspace, started, error);
  }
}

async function runAcceptEditsCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "writes a file in acceptEdits mode without prompting");
  const workspace = workspaceFor(iteration, "accept-edits");
  const started = performance.now();
  try {
    await mkdir(workspace, { recursive: true });
    const result = await runShannonOneShot({
      cwd: workspace,
      args: [
        "code",
        "--accept-edits",
        "--max-turns",
        "5",
        [
          "Create accept.txt with the exact content accepted-dogfood using write_file.",
          "Then answer exactly DOGFOOD_ACCEPT_EDITS_OK.",
        ].join(" "),
      ],
      timeoutMs: 150_000,
    });
    const content = await readIfExists(resolve(workspace, "accept.txt"));
    const checks = {
      exited: result.code === 0,
      wroteFile: content.includes("accepted-dogfood"),
      noApprovalUnavailable: !result.stdout.includes("interactive approval is not available"),
      noInteractivePrompt: !result.stdout.includes("Approve tool?"),
      finalMarker: result.stdout.includes("DOGFOOD_ACCEPT_EDITS_OK"),
    };

    return completeCase({
      name,
      category: "permissions",
      workspace,
      started,
      result,
      checks,
      requiredChecks: [
        "exited",
        "wroteFile",
        "noApprovalUnavailable",
        "noInteractivePrompt",
      ],
      findings: markerFinding(
        checks.finalMarker,
        "acceptEdits final marker was missing",
      ),
    });
  } catch (error) {
    return failedCase(name, "permissions", workspace, started, error);
  }
}

async function runDontAskDenyCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "denies write_file predictably in dontAsk mode");
  const workspace = workspaceFor(iteration, "dont-ask");
  const started = performance.now();
  try {
    await mkdir(workspace, { recursive: true });
    const result = await runShannonOneShot({
      cwd: workspace,
      args: [
        "code",
        "--dont-ask",
        "--max-turns",
        "5",
        [
          "Create denied-dontask.txt with the exact content blocked-dogfood using write_file.",
          "If dontAsk mode blocks the write, do not retry.",
          "Answer exactly DOGFOOD_DONTASK_DENIED_OK.",
        ].join(" "),
      ],
      timeoutMs: 150_000,
    });
    const checks = {
      exited: result.code === 0,
      fileAbsent: !existsSync(resolve(workspace, "denied-dontask.txt")),
      sawDontAskDenial: result.stdout.includes("requires approval and cannot run in dontAsk"),
      noInteractivePrompt: !result.stdout.includes("Approve tool?"),
      finalMarker: result.stdout.includes("DOGFOOD_DONTASK_DENIED_OK"),
    };

    return completeCase({
      name,
      category: "permissions",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "fileAbsent", "sawDontAskDenial", "noInteractivePrompt"],
      findings: markerFinding(
        checks.finalMarker,
        "dontAsk denial final marker was missing",
      ),
    });
  } catch (error) {
    return failedCase(name, "permissions", workspace, started, error);
  }
}

async function runSkillCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "runs a project skill from the REPL");
  const workspace = workspaceFor(iteration, "skill");
  const started = performance.now();
  try {
    await writeWorkspaceFile(
      workspace,
      ".agent/skills/dogfood/SKILL.md",
      [
        "---",
        "name: dogfood",
        "description: Dogfood marker skill.",
        "mode: inline",
        "allowed_tools: []",
        "---",
        "When invoked, answer exactly DOGFOOD_SKILL_OK.",
        "Do not call tools.",
        "",
      ].join("\n"),
    );
    const result = await runShannonScriptedRepl({
      cwd: workspace,
      lines: ["/skill dogfood now"],
      approvalAnswer: "a",
      maxTurns: 3,
      timeoutMs: 120_000,
    });
    const checks = {
      exited: result.code === 0,
      finalMarker: result.stdout.includes("DOGFOOD_SKILL_OK"),
      noToolCall: !result.stdout.includes("[tool]"),
    };

    return completeCase({
      name,
      category: "skills",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "finalMarker", "noToolCall"],
      findings: [],
    });
  } catch (error) {
    return failedCase(name, "skills", workspace, started, error);
  }
}

async function runWebFetchCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "fetches a local HTTP page");
  const workspace = workspaceFor(iteration, "web-fetch");
  const started = performance.now();
  let server: Server | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><h1>DOGFOOD_WEB_MARKER</h1></body></html>");
    });
    const url = `${await listenHttp(server)}/page`;
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        `Use web_fetch to fetch ${url}.`,
        "After you see DOGFOOD_WEB_MARKER in the tool result, answer exactly DOGFOOD_WEB_FETCH_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 5,
      timeoutMs: 150_000,
    });
    const checks = {
      exited: result.code === 0,
      usedWebFetch: result.stdout.includes("[tool] web_fetch"),
      sawMarker: result.stdout.includes("DOGFOOD_WEB_MARKER"),
      finalMarker: result.stdout.includes("DOGFOOD_WEB_FETCH_OK"),
    };

    return completeCase({
      name,
      category: "web",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "usedWebFetch", "sawMarker"],
      findings: markerFinding(checks.finalMarker, "web_fetch final marker was missing"),
    });
  } catch (error) {
    return failedCase(name, "web", workspace, started, error);
  } finally {
    await closeServer(server);
  }
}

async function runUnicodePathCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "creates a browser file under a Chinese path");
  const workspace = resolve(workspaceFor(iteration, "unicode"), "中文路径");
  const started = performance.now();
  try {
    await mkdir(workspace, { recursive: true });
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Create a minimal browser counter app in a single file named index.html.",
        "You must use write_file to create index.html in the current workspace.",
        "The page should contain the text DOGFOOD_UNICODE_COUNTER.",
        "After writing the file, answer exactly DOGFOOD_UNICODE_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 7,
      timeoutMs: 180_000,
    });
    const content = await readIfExists(resolve(workspace, "index.html"));
    const checks = {
      exited: result.code === 0,
      sawApproval: result.stdout.includes("Permission request: write_file"),
      wroteIndex: content.length > 0,
      containsMarker: content.includes("DOGFOOD_UNICODE_COUNTER"),
      finalMarker: result.stdout.includes("DOGFOOD_UNICODE_OK"),
    };

    return completeCase({
      name,
      category: "windows path",
      workspace,
      started,
      result,
      checks,
      requiredChecks: ["exited", "sawApproval", "wroteIndex", "containsMarker"],
      findings: markerFinding(
        checks.finalMarker,
        "unicode path final marker was missing",
      ),
    });
  } catch (error) {
    return failedCase(name, "windows path", workspace, started, error);
  }
}

async function runResumeCase(iteration: number): Promise<CaseResult> {
  const name = caseName(iteration, "resumes the latest session");
  const workspace = workspaceFor(iteration, "resume");
  const started = performance.now();
  try {
    await mkdir(workspace, { recursive: true });
    const seed = await runShannonOneShot({
      cwd: workspace,
      args: [
        "code",
        "--max-turns",
        "2",
        "Remember this exact dogfood code for the next turn: PAPAYA-73. Reply exactly DOGFOOD_RESUME_SEEDED.",
      ],
      timeoutMs: 90_000,
    });
    const resumed = await runShannonOneShot({
      cwd: workspace,
      args: [
        "code",
        "--resume",
        "--max-turns",
        "2",
        "What exact dogfood code did I ask you to remember? Reply with only the code.",
      ],
      timeoutMs: 90_000,
    });
    const stdout = [seed.stdout, "--- resume ---", resumed.stdout].join("\n");
    const stderr = [seed.stderr, resumed.stderr].filter(Boolean).join("\n");
    const checks = {
      seedExited: seed.code === 0,
      resumeExited: resumed.code === 0,
      sessionSaved: existsSync(resolve(workspace, ".agent", "sessions")),
      seedMarker: seed.stdout.includes("DOGFOOD_RESUME_SEEDED"),
      recalled: resumed.stdout.includes("PAPAYA-73"),
    };

    return {
      name,
      category: "session",
      passed: Object.entries(checks)
        .filter(([key]) => key !== "seedMarker")
        .every(([, value]) => value),
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      checks,
      findings: markerFinding(checks.seedMarker, "resume seed marker was missing"),
    };
  } catch (error) {
    return failedCase(name, "session", workspace, started, error);
  }
}

function runShannonRepl(input: {
  cwd: string;
  userInput: string;
  approvalAnswer: "y" | "n" | "a";
  maxTurns: number;
  timeoutMs: number;
}): Promise<CliRunResult> {
  return runShannonScriptedRepl({
    cwd: input.cwd,
    lines: [input.userInput],
    approvalAnswer: input.approvalAnswer,
    maxTurns: input.maxTurns,
    timeoutMs: input.timeoutMs,
  });
}

function runShannonScriptedRepl(input: {
  cwd: string;
  lines: string[];
  approvalAnswer: "y" | "n" | "a";
  maxTurns: number;
  timeoutMs: number;
  extraArgs?: string[];
}): Promise<CliRunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawnShannon(["code", ...(input.extraArgs ?? []), "--max-turns", String(input.maxTurns)], {
      cwd: input.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const pendingLines = [...input.lines];
    let sentExit = false;
    let handledApprovalOffset = 0;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`shannon code timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      const approvalOffset = stdout.indexOf(
        "Approve tool? yes/no/always [y/N/a]: ",
        handledApprovalOffset,
      );
      if (approvalOffset !== -1) {
        handledApprovalOffset = stdout.length;
        child.stdin!.write(`${input.approvalAnswer}\n`);
        return;
      }

      if (!stdout.endsWith("You > ")) {
        return;
      }

      const nextLine = pendingLines.shift();
      if (nextLine !== undefined) {
        child.stdin!.write(`${nextLine}\n`);
        return;
      }

      if (!sentExit) {
        sentExit = true;
        child.stdin!.write("/exit\n");
        child.stdin!.end();
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveResult({ stdout, stderr, code });
    });
  });
}

function runShannonOneShot(input: {
  cwd: string;
  args: string[];
  timeoutMs: number;
}): Promise<CliRunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawnShannon(input.args, {
      cwd: input.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`shannon code one-shot timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveResult({ stdout, stderr, code });
    });
  });
}

function spawnShannon(
  args: string[],
  options: NonNullable<Parameters<typeof spawn>[2]>,
): ReturnType<typeof spawn> {
  const override = process.env.SHANNON_DOGFOOD_BIN;
  if (override) {
    if (process.platform === "win32") {
      return spawn("cmd.exe", ["/d", "/s", "/c", commandLine([override, ...args])], options);
    }
    return spawn(override, args, options);
  }

  const localCli = resolve(projectRoot, "dist", "cli", "shannon.js");
  if (existsSync(localCli)) {
    return spawn(process.execPath, [localCli, ...args], options);
  }

  const command = "shannon";
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", commandLine([command, ...args])], options);
  }
  return spawn(command, args, options);
}

function commandLine(args: string[]): string {
  return args.map((arg) => quoteShellArg(arg)).join(" ");
}

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(arg)) {
    return arg;
  }
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function writeWorkspaceFile(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = resolve(workspace, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function listArtifactFiles(workspace: string): Promise<string[]> {
  const root = resolve(workspace, ".agent", "artifacts");
  try {
    return await walkFiles(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(path);
      }
      return entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

async function listenHttp(server: Server): Promise<string> {
  await new Promise<void>((resolveListener) => {
    server.listen(0, "127.0.0.1", resolveListener);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }

  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
}

function completeCase(input: {
  name: string;
  category: string;
  workspace: string;
  started: number;
  result: CliRunResult;
  checks: Record<string, boolean>;
  requiredChecks: string[];
  findings: Finding[];
}): CaseResult {
  const requiredPassed = input.requiredChecks.every((key) => input.checks[key]);
  const failedRequired = input.requiredChecks.filter((key) => !input.checks[key]);
  const findings = [
    ...input.findings,
    ...failedRequired.map(
      (key): Finding => ({
        kind: "bug",
        message: `Required check failed: ${key}`,
      }),
    ),
  ];

  return {
    name: input.name,
    category: input.category,
    passed: requiredPassed,
    durationMs: performance.now() - input.started,
    workspace: input.workspace,
    stdout: truncate(input.result.stdout),
    stderr: truncate(input.result.stderr),
    checks: input.checks,
    findings,
  };
}

function failedCase(
  name: string,
  category: string,
  workspace: string,
  started: number,
  error: unknown,
): CaseResult {
  return {
    name,
    category,
    passed: false,
    durationMs: performance.now() - started,
    workspace,
    stdout: "",
    stderr: "",
    checks: {},
    findings: [
      {
        kind: "bug",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
    error: error instanceof Error ? error.message : String(error),
  };
}

function markerFinding(markerPresent: boolean, message: string): Finding[] {
  return markerPresent ? [] : [{ kind: "variance", message }];
}

function caseName(iteration: number, name: string): string {
  return repeatCount > 1 ? `run ${iteration}/${repeatCount}: ${name}` : name;
}

function workspaceFor(iteration: number, slug: string): string {
  return resolve(tempRoot, `run-${iteration}`, slug);
}

function truncate(value: string, maxLength = 8_000): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated]`;
}

function parseRepeatCount(value: string | undefined): number {
  if (!value) {
    return 1;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }

  return Math.min(parsed, 5);
}

function formatMarkdownReport(summary: DogfoodSummary): string {
  const groupedFindings = summary.cases.flatMap((result) =>
    result.findings.map((finding) => ({ ...finding, caseName: result.name })),
  );
  const passCount = summary.cases.filter((result) => result.passed).length;

  return [
    "# Dogfood Report",
    "",
    `Started: \`${summary.startedAt}\``,
    `Model: \`${summary.model}\``,
    `Base URL: \`${summary.baseURL}\``,
    `Repeat count: \`${summary.repeatCount}\``,
    `Workspace root: \`${summary.tempRoot}\``,
    `Workspaces retained: \`${String(summary.retainedWorkspaces)}\``,
    "",
    `Overall: **${summary.passed ? "PASS" : "FAIL"}** (${passCount}/${summary.cases.length})`,
    "",
    "## Coverage",
    "",
    "| Case | Category | Result | Duration |",
    "| --- | --- | --- | ---: |",
    ...summary.cases.map(
      (result) =>
        `| ${escapeTable(result.name)} | ${escapeTable(result.category)} | ${
          result.passed ? "PASS" : "FAIL"
        } | ${result.durationMs.toFixed(0)}ms |`,
    ),
    "",
    "## Findings",
    "",
    groupedFindings.length === 0
      ? "No dogfood findings were recorded."
      : groupedFindings
          .map(
            (finding) =>
              `- **${finding.kind}** in ${finding.caseName}: ${finding.message}`,
          )
          .join("\n"),
    "",
    "## Checks",
    "",
    ...summary.cases.flatMap((result) => [
      `### ${result.name}`,
      "",
      `- Result: ${result.passed ? "PASS" : "FAIL"}`,
      `- Workspace: \`${result.workspace}\``,
      `- Checks: \`${JSON.stringify(result.checks)}\``,
      result.error ? `- Error: ${result.error}` : "",
      "",
    ]),
  ].join("\n");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
