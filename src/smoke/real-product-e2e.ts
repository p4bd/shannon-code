#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadDotEnv } from "../utils/env.js";

const projectRoot = process.cwd();
await loadDotEnv(projectRoot, { override: true });

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY.");
}

interface CaseResult {
  name: string;
  passed: boolean;
  durationMs: number;
  workspace: string;
  stdout: string;
  stderr: string;
  error?: string;
  checks: Record<string, boolean>;
}

interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const reportPath = resolve(projectRoot, "real-product-e2e-report.json");
const reportMarkdownPath = resolve(projectRoot, "real-product-e2e-report.md");
const tempRoot = resolve(tmpdir(), "shannon-real-product-e2e");
const cases: CaseResult[] = [];

await rm(tempRoot, { recursive: true, force: true });
await mkdir(tempRoot, { recursive: true });

try {
  cases.push(await runSnakeCase());
  cases.push(await runDeniedWriteCase());
  cases.push(await runResumeCase());
  cases.push(await runShellRecoveryCase());
  cases.push(await runToolSearchCase());
  cases.push(await runWebFetchCase());
  cases.push(await runPlanModeCase());
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const passed = cases.every((result) => result.passed);
await writeFile(
  reportPath,
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      passed,
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      cases,
    },
    null,
    2,
  ),
  "utf8",
);
await writeFile(reportMarkdownPath, formatMarkdownReport(cases), "utf8");

console.log(
  `REAL_PRODUCT_E2E ${passed ? "PASS" : "FAIL"}: ${
    cases.filter((result) => result.passed).length
  }/${cases.length} cases passed.`,
);
console.log(`Reports: ${reportPath}, ${reportMarkdownPath}`);

if (!passed) {
  process.exitCode = 1;
}

async function runSnakeCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "贪吃蛇");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  try {
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Create a concise browser snake game in a single file named index.html.",
        "You must use write_file to create index.html in the current workspace.",
        "After writing the file, answer exactly REAL_E2E_SNAKE_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 8,
      timeoutMs: 180_000,
    });
    const filePath = resolve(workspace, "index.html");
    const content = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
    const checks = {
      exited: result.code === 0,
      wroteIndex: content.length > 0,
      hasGameSignals: /canvas|keydown|snake|贪吃蛇/i.test(content),
      sawApproval: result.stdout.includes("Permission request: write_file"),
      finalMarker: result.stdout.includes("REAL_E2E_SNAKE_OK"),
    };

    return {
      name: "real model creates snake game in Chinese path",
      passed:
        checks.exited &&
        checks.wroteIndex &&
        checks.hasGameSignals &&
        checks.sawApproval,
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      checks,
    };
  } catch (error) {
    return failedCase("real model creates snake game in Chinese path", workspace, started, error);
  }
}

async function runDeniedWriteCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "deny-write");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  try {
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Create a file named denied.txt with the content denied.",
        "You must call write_file to create it.",
        "If the write is denied, answer exactly REAL_E2E_DENIED_OK.",
      ].join(" "),
      approvalAnswer: "n",
      maxTurns: 5,
      timeoutMs: 120_000,
    });
    const checks = {
      exited: result.code === 0,
      sawApproval: result.stdout.includes("Permission request: write_file"),
      deniedMessage: result.stdout.includes("denied by the user"),
      fileAbsent: !existsSync(resolve(workspace, "denied.txt")),
    };

    return {
      name: "real model handles denied write approval",
      passed: Object.values(checks).every(Boolean),
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      checks,
    };
  } catch (error) {
    return failedCase("real model handles denied write approval", workspace, started, error);
  }
}

async function runResumeCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "resume");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  try {
    const seed = await runShannonOneShot({
      cwd: workspace,
      args: [
        "Remember this exact code for the next turn: BANANA-42. Reply exactly REAL_E2E_RESUME_SEEDED.",
      ],
      timeoutMs: 90_000,
    });
    const resumed = await runShannonOneShot({
      cwd: workspace,
      args: [
        "--resume",
        "What exact code did I ask you to remember? Reply with only the code.",
      ],
      timeoutMs: 90_000,
    });
    const checks = {
      seedExited: seed.code === 0,
      resumeExited: resumed.code === 0,
      seedSessionSaved: existsSync(resolve(workspace, ".agent", "sessions")),
      recalled: resumed.stdout.includes("BANANA-42"),
    };

    return {
      name: "real model resumes prior session",
      passed: Object.values(checks).every(Boolean),
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate([seed.stdout, resumed.stdout].join("\n--- resume ---\n")),
      stderr: truncate([seed.stderr, resumed.stderr].filter(Boolean).join("\n")),
      checks,
    };
  } catch (error) {
    return failedCase("real model resumes prior session", workspace, started, error);
  }
}

async function runShellRecoveryCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "shell-recovery");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  try {
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        "Use run_shell to run this failing command first: node missing-script.js.",
        "Then recover by running node --version.",
        "After observing the recovery command output, answer exactly REAL_E2E_SHELL_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 8,
      timeoutMs: 180_000,
    });
    const checks = {
      exited: result.code === 0,
      sawShellTool: result.stdout.includes("[tool] run_shell"),
      sawFailure:
        result.stdout.includes("CommandFailed") ||
        result.stdout.includes("Cannot find module"),
      sawRecovery: /v\d+\.\d+\.\d+/.test(result.stdout),
      finalMarker: result.stdout.includes("REAL_E2E_SHELL_OK"),
    };

    return {
      name: "real model recovers from shell failure",
      passed:
        checks.exited &&
        checks.sawShellTool &&
        checks.sawFailure &&
        checks.sawRecovery,
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      checks,
    };
  } catch (error) {
    return failedCase("real model recovers from shell failure", workspace, started, error);
  }
}

async function runToolSearchCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "tool-search");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  try {
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        'Use tool_search with query "fetch".',
        "After you see the web_fetch tool schema, answer exactly REAL_E2E_TOOL_SEARCH_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 5,
      timeoutMs: 120_000,
    });
    const checks = {
      exited: result.code === 0,
      sawToolSearch: result.stdout.includes("[tool] tool_search"),
      sawWebFetch: result.stdout.includes("web_fetch"),
      finalMarker: result.stdout.includes("REAL_E2E_TOOL_SEARCH_OK"),
    };

    return {
      name: "real model uses tool_search",
      passed: Object.values(checks).every(Boolean),
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      checks,
    };
  } catch (error) {
    return failedCase("real model uses tool_search", workspace, started, error);
  }
}

async function runWebFetchCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "web-fetch");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  let server: Server | undefined;
  try {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><h1>REAL_WEB_MARKER</h1></body></html>");
    });
    const url = `${await listenHttp(server)}/page`;
    const result = await runShannonRepl({
      cwd: workspace,
      userInput: [
        `Use web_fetch to fetch ${url}.`,
        "After you see REAL_WEB_MARKER in the tool result, answer exactly REAL_E2E_WEB_FETCH_OK.",
      ].join(" "),
      approvalAnswer: "a",
      maxTurns: 5,
      timeoutMs: 120_000,
    });
    const checks = {
      exited: result.code === 0,
      sawWebFetchTool: result.stdout.includes("[tool] web_fetch"),
      sawMarker: result.stdout.includes("REAL_WEB_MARKER"),
      finalMarker: result.stdout.includes("REAL_E2E_WEB_FETCH_OK"),
    };

    return {
      name: "real model uses web_fetch",
      passed: Object.values(checks).every(Boolean),
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      checks,
    };
  } catch (error) {
    return failedCase("real model uses web_fetch", workspace, started, error);
  } finally {
    await closeServer(server);
  }
}

async function runPlanModeCase(): Promise<CaseResult> {
  const workspace = resolve(tempRoot, "plan-mode");
  await mkdir(workspace, { recursive: true });
  const started = performance.now();
  try {
    const result = await runShannonScriptedRepl({
      cwd: workspace,
      lines: [
        [
          "/plan Create a file named planned-real.txt with the exact content plan-real.",
          "The execution must use write_file.",
          "After execution, the final answer must include REAL_E2E_PLAN_OK.",
        ].join(" "),
        "/plan approve",
      ],
      approvalAnswer: "a",
      maxTurns: 8,
      timeoutMs: 180_000,
    });
    const filePath = resolve(workspace, "planned-real.txt");
    const content = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
    const checks = {
      exited: result.code === 0,
      planSaved: result.stdout.includes("Plan saved to"),
      sawApproval: result.stdout.includes("Permission request: write_file"),
      executedPlan: result.stdout.includes("Executed plan"),
      wroteFile: content.includes("plan-real"),
    };

    return {
      name: "real model plans then executes after approval",
      passed: Object.values(checks).every(Boolean),
      durationMs: performance.now() - started,
      workspace,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      checks,
    };
  } catch (error) {
    return failedCase("real model plans then executes after approval", workspace, started, error);
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
}): Promise<CliRunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawnShannon(["code", "--max-turns", String(input.maxTurns)], {
      cwd: input.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const pendingLines = [...input.lines];
    let sentExit = false;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`shannon code timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.endsWith("Approve tool? yes/no/always [y/N/a]: ")) {
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

function runShannonOneShot(input: {
  cwd: string;
  args: string[];
  timeoutMs: number;
}): Promise<CliRunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawnShannon(["code", ...input.args], {
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

function failedCase(
  name: string,
  workspace: string,
  started: number,
  error: unknown,
): CaseResult {
  return {
    name,
    passed: false,
    durationMs: performance.now() - started,
    workspace,
    stdout: "",
    stderr: "",
    error: error instanceof Error ? error.message : String(error),
    checks: {},
  };
}

function truncate(value: string, maxLength = 6_000): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated]`;
}

function formatMarkdownReport(cases: CaseResult[]): string {
  return [
    "# Real Product E2E Report",
    "",
    `Model: \`${process.env.OPENAI_MODEL ?? "gpt-4.1-mini"}\``,
    "",
    "| Case | Result | Duration |",
    "| --- | --- | ---: |",
    ...cases.map(
      (result) =>
        `| ${result.name} | ${result.passed ? "PASS" : "FAIL"} | ${result.durationMs.toFixed(1)}ms |`,
    ),
    "",
    "## Details",
    "",
    ...cases.flatMap((result) => [
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
