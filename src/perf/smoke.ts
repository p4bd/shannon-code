#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Agent } from "../core/agent.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../core/model-provider.js";
import { listFilesTool } from "../tools/list-files.tool.js";
import { grepSearchTool } from "../tools/grep-search.tool.js";
import { InMemoryReadTracker } from "../context/read-tracker.js";
import { PassthroughLargeResultStore } from "../context/large-result-store.js";
import { NoopLogger } from "../utils/logger.js";

interface PerfMetric {
  name: string;
  durationMs: number;
  thresholdMs: number;
  passed: boolean;
}

const PROJECT_ROOT = process.cwd();
const REPORT_JSON = resolve(PROJECT_ROOT, "performance-report.json");
const REPORT_MD = resolve(PROJECT_ROOT, "performance-report.md");

async function prepareWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "hot.txt"), "hot path\n", "utf8");
  for (let index = 0; index < 240; index += 1) {
    const dir = join(workspace, "src", `module-${index}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `file-${index}.ts`),
      [
        `export const value${index} = ${index};`,
        index === 239
          ? "export const targetSymbol239 = true;"
          : `export const filler${index} = "stable";`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

async function recordMetric(
  name: string,
  thresholdMs: number,
  run: () => Promise<void>,
): Promise<void> {
  const start = performance.now();
  let failed = false;
  try {
    await run();
  } catch (error) {
    failed = true;
    console.error(`Performance step failed: ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const durationMs = performance.now() - start;
  metrics.push({
    name,
    durationMs,
    thresholdMs,
    passed: !failed && durationMs <= thresholdMs,
  });
}

function createToolContext(cwd: string) {
  return {
    cwd,
    sessionId: "perf-session",
    permissionMode: "default" as const,
    subagentDepth: 0,
    readTracker: new InMemoryReadTracker(),
    artifactStore: new PassthroughLargeResultStore(),
    logger: new NoopLogger(),
  };
}

class ReadLoopProvider implements ModelProvider {
  readonly name = "perf-read-loop";
  readonly supportsToolCalling = true;
  readonly supportsStreaming = false;
  readonly supportsPromptCaching = false;
  private requests = 0;

  constructor(private readonly loops: number) {}

  async createMessage(_input: ModelRequest): Promise<ModelResponse> {
    this.requests += 1;
    if (this.requests <= this.loops) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_read_${this.requests}`,
            name: "read_file",
            input: { path: "hot.txt" },
            rawArguments: JSON.stringify({ path: "hot.txt" }),
          },
        ],
      };
    }

    return { content: "done", toolCalls: [] };
  }

  async *createMessageStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: { content: "unused", toolCalls: [] } };
  }
}

function formatMarkdown(report: {
  startedAt: string;
  passed: boolean;
  metrics: PerfMetric[];
}): string {
  return [
    "# Performance Smoke Report",
    "",
    `Started: ${report.startedAt}`,
    `Result: ${report.passed ? "PASS" : "FAIL"}`,
    "",
    "| Metric | Result | Duration | Threshold |",
    "| --- | --- | ---: | ---: |",
    ...report.metrics.map(
      (metric) =>
        `| ${metric.name} | ${metric.passed ? "PASS" : "FAIL"} | ${metric.durationMs.toFixed(1)}ms | ${metric.thresholdMs}ms |`,
    ),
    "",
  ].join("\n");
}

const metrics: PerfMetric[] = [];
const tempRoot = await mkdtemp(join(tmpdir(), "shannon-perf-"));

try {
  await prepareWorkspace(tempRoot);
  await recordMetric("list_files recursive 240 files", 1_500, async () => {
    const result = await listFilesTool.execute(
      { path: ".", recursive: true, includeHidden: false, limit: 1_000 },
      createToolContext(tempRoot),
    );
    if (!result.ok || !result.content.includes("src/module-239/file-239.ts")) {
      throw new Error("list_files did not return expected file.");
    }
  });

  await recordMetric("grep_search 240 files", 3_000, async () => {
    const result = await grepSearchTool.execute(
      { pattern: "targetSymbol239", path: "src", include: "*.ts" },
      createToolContext(tempRoot),
    );
    if (!result.ok || !result.content.includes("targetSymbol239")) {
      throw new Error("grep_search did not return expected match.");
    }
  });

  await recordMetric("agent 30 read_file loop", 6_000, async () => {
    const provider = new ReadLoopProvider(30);
    const agent = new Agent({ provider, cwd: tempRoot, maxTurns: 35 });
    const result = await agent.run("Read hot.txt repeatedly.");
    if (result.stoppedByMaxTurns || result.toolResults.length !== 30) {
      throw new Error(`Unexpected agent loop result: ${result.toolResults.length} tools.`);
    }
  });
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const passed = metrics.every((metric) => metric.passed);
const report = {
  startedAt: new Date().toISOString(),
  passed,
  metrics,
};
await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(REPORT_MD, formatMarkdown(report), "utf8");

console.log(
  `Performance ${passed ? "PASS" : "FAIL"}: ${metrics.filter((metric) => metric.passed).length}/${metrics.length} metrics passed.`,
);
for (const metric of metrics) {
  console.log(
    `${metric.passed ? "PASS" : "FAIL"} ${metric.name}: ${metric.durationMs.toFixed(1)}ms <= ${metric.thresholdMs}ms`,
  );
}
console.log("Reports: performance-report.json, performance-report.md");

if (!passed) {
  process.exitCode = 1;
}
