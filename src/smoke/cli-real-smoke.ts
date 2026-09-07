#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { loadDotEnv } from "../utils/env.js";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const marker = "shannon-real-cli-smoke-marker";
const reportJsonPath = resolve(projectRoot, "real-cli-smoke-report.json");
const reportMarkdownPath = resolve(projectRoot, "real-cli-smoke-report.md");

interface RealCliSmokeReport {
  startedAt: string;
  durationMs: number;
  passed: boolean;
  model: string;
  baseURL: string;
  checks: {
    toolCalled: boolean;
    markerObserved: boolean;
    finalAnswerObserved: boolean;
  };
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

await loadDotEnv(projectRoot);

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY.");
}

const workspace = await mkdtemp(join(tmpdir(), "shannon-real-cli-smoke-"));
const startedAt = new Date().toISOString();
const start = performance.now();
let stdout = "";
let stderr = "";
let passed = false;
let errorMessage: string | undefined;

try {
  await writeFile(
    join(workspace, "fixture.txt"),
    `This file contains ${marker}.\n`,
    "utf8",
  );

  const cliPath = resolve(projectRoot, "dist", "cli", "index.js");
  const result = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "--max-turns",
      "4",
      [
        "Use the read_file tool to read fixture.txt.",
        `If the file contains ${marker}, answer exactly REAL_CLI_SMOKE_OK.`,
        "Do not answer before using the tool.",
      ].join(" "),
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: baseURL ?? "",
        OPENAI_MODEL: model,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  stdout = result.stdout;
  stderr = result.stderr;
  passed =
    stdout.includes("[tool] read_file") &&
    stdout.includes(marker) &&
    stdout.includes("REAL_CLI_SMOKE_OK");
  if (!passed) {
    errorMessage = "CLI completed but did not prove read_file tool use and final marker response.";
  }
} catch (error) {
  const execError = error as Partial<{
    stdout: string;
    stderr: string;
    message: string;
  }>;
  stdout = execError.stdout ?? "";
  stderr = execError.stderr ?? "";
  errorMessage = error instanceof Error ? error.message : String(error);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

const durationMs = performance.now() - start;
const report: RealCliSmokeReport = {
  startedAt,
  durationMs,
  passed,
  model,
  baseURL: sanitizeBaseURL(baseURL),
  checks: {
    toolCalled: stdout.includes("[tool] read_file"),
    markerObserved: stdout.includes(marker),
    finalAnswerObserved: stdout.includes("REAL_CLI_SMOKE_OK"),
  },
  stdout: truncate(stdout, 4_000),
  stderr: truncate(stderr, 4_000),
  errorMessage,
};

await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(reportMarkdownPath, formatMarkdown(report), "utf8");

console.log(
  `REAL_CLI_SMOKE ${passed ? "PASS" : "FAIL"} duration=${durationMs.toFixed(1)}ms model=${model}`,
);
console.log(`tool_called=${report.checks.toolCalled}`);
console.log(`marker_observed=${report.checks.markerObserved}`);
console.log(`final_answer_observed=${report.checks.finalAnswerObserved}`);
console.log("Reports: real-cli-smoke-report.json, real-cli-smoke-report.md");

if (!passed) {
  process.exitCode = 1;
}

function sanitizeBaseURL(value: string | undefined): string {
  if (!value) {
    return "default";
  }

  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function formatMarkdown(report: RealCliSmokeReport): string {
  return [
    "# Real CLI Smoke Report",
    "",
    `Started: ${report.startedAt}`,
    `Result: ${report.passed ? "PASS" : "FAIL"}`,
    `Duration: ${report.durationMs.toFixed(1)}ms`,
    `Model: ${report.model}`,
    `Base URL: ${report.baseURL}`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| read_file tool called | ${report.checks.toolCalled ? "PASS" : "FAIL"} |`,
    `| fixture marker observed | ${report.checks.markerObserved ? "PASS" : "FAIL"} |`,
    `| final answer observed | ${report.checks.finalAnswerObserved ? "PASS" : "FAIL"} |`,
    "",
    report.errorMessage ? `Error: ${report.errorMessage}` : "",
    "",
  ].join("\n");
}
