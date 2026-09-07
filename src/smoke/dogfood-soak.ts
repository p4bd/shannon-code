#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { OpenAICompatibleProvider } from "../core/openai-provider.js";
import type { ModelProvider } from "../core/model-provider.js";
import { loadDotEnv } from "../utils/env.js";

const projectRoot = process.cwd();
await loadDotEnv(projectRoot, { override: true });

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY.");
}

type FindingKind = "bug" | "stability" | "quality" | "ux" | "variance" | "info";

interface Finding {
  kind: FindingKind;
  message: string;
}

interface QualityScore {
  target: string;
  score: number;
  source: "heuristic" | "judge";
  positives: string[];
  issues: string[];
}

interface StepResult {
  name: string;
  durationMs: number;
  checks: Record<string, boolean>;
  findings: Finding[];
}

interface RoundResult {
  round: number;
  domain: string;
  workspace: string;
  passed: boolean;
  correctnessPassed: boolean;
  qualityPassed: boolean;
  stabilityPassed: boolean;
  durationMs: number;
  steps: StepResult[];
  checks: Record<string, boolean>;
  quality: QualityScore[];
  findings: Finding[];
  stdout: string;
  stderr: string;
  localTest: LocalCommandResult;
  error?: string;
}

interface SoakSummary {
  startedAt: string;
  durationMs: number;
  passed: boolean;
  roundsRequested: number;
  retainedWorkspaces: boolean;
  tempRoot: string;
  model: string;
  baseURL: string;
  qualityJudge: boolean;
  rounds: RoundResult[];
}

interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface LocalCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface ProjectSeed {
  domain: string;
  slug: string;
  sourceFile: string;
  passMarker: string;
  terms: string[];
  files: Record<string, string>;
}

const reportJsonPath = resolve(projectRoot, "dogfood-soak-report.json");
const reportMarkdownPath = resolve(projectRoot, "DOGFOOD_SOAK_REPORT.md");
const tempRoot = resolve(tmpdir(), `shannon-dogfood-soak-${process.pid}`);
const roundCount = parseRoundCount(process.env.DOGFOOD_SOAK_ROUNDS);
const keepWorkspace = process.env.DOGFOOD_SOAK_KEEP_WORKSPACE === "1";
const judgeEnabled = process.env.DOGFOOD_SOAK_JUDGE !== "0";
const judgeProvider = judgeEnabled
  ? new OpenAICompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: emptyToUndefined(process.env.OPENAI_BASE_URL),
      model: emptyToUndefined(process.env.OPENAI_MODEL),
    })
  : undefined;

const startedAt = new Date().toISOString();
const started = performance.now();
const rounds: RoundResult[] = [];

await rm(tempRoot, { recursive: true, force: true });
await mkdir(tempRoot, { recursive: true });

for (let round = 1; round <= roundCount; round += 1) {
  const seed = createProjectSeed(round);
  console.log(`[soak] round ${round}/${roundCount} start: ${seed.domain}`);
  const result = await runRound(round, seed, judgeProvider);
  rounds.push(result);
  console.log(
    `[soak] round ${round}/${roundCount} ${result.passed ? "PASS" : "FAIL"}: ` +
      `correctness=${result.correctnessPassed} quality=${result.qualityPassed} stability=${result.stabilityPassed}`,
  );
}

const passed = rounds.every((round) => round.passed);
const retainedWorkspaces = keepWorkspace || !passed;
const summary: SoakSummary = {
  startedAt,
  durationMs: performance.now() - started,
  passed,
  roundsRequested: roundCount,
  retainedWorkspaces,
  tempRoot,
  model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  baseURL: process.env.OPENAI_BASE_URL ? "[configured]" : "[default]",
  qualityJudge: Boolean(judgeProvider),
  rounds,
};

await writeFile(reportJsonPath, JSON.stringify(summary, null, 2), "utf8");
await writeFile(reportMarkdownPath, formatMarkdownReport(summary), "utf8");

if (!retainedWorkspaces) {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(
  `DOGFOOD_SOAK ${passed ? "PASS" : "FAIL"}: ${
    rounds.filter((round) => round.passed).length
  }/${rounds.length} rounds passed in ${(summary.durationMs / 1000).toFixed(1)}s.`,
);
console.log(`Reports: ${reportJsonPath}, ${reportMarkdownPath}`);
console.log(
  retainedWorkspaces
    ? `Workspaces retained at: ${tempRoot}`
    : "Temporary workspaces cleaned up.",
);

if (!passed) {
  process.exitCode = 1;
}

async function runRound(
  round: number,
  seed: ProjectSeed,
  provider: ModelProvider | undefined,
): Promise<RoundResult> {
  const workspace = resolve(tempRoot, `round-${round}-${seed.slug}`);
  const roundStarted = performance.now();
  const markers = {
    orient: `SOAK_R${round}_ORIENT_OK`,
    fix: `SOAK_R${round}_FIX_OK`,
    review: `SOAK_R${round}_REVIEW_OK`,
    docs: `SOAK_R${round}_DOCS_OK`,
    typo: `SOAK_R${round}_TYPO_OK`,
    artifact: `SOAK_R${round}_ARTIFACT_OK`,
    roadmap: `SOAK_R${round}_ROADMAP_OK`,
    final: `SOAK_R${round}_FINAL_OK`,
  };

  try {
    await prepareWorkspace(workspace, seed);
    const lines = buildRoundPrompts(round, seed, markers);
    const result = await runShannonScriptedRepl({
      cwd: workspace,
      lines,
      approvalAnswers: [],
      defaultApprovalAnswer: "a",
      maxTurns: 14,
      timeoutMs: 1_200_000,
    });
    const localTest = await runLocalCommand({
      cwd: workspace,
      command: npmCommand(),
      args: ["test"],
      timeoutMs: 120_000,
    });
    const artifacts = await readRoundArtifacts(workspace);
    const quality = await scoreRoundQuality({
      round,
      seed,
      stdout: result.stdout,
      artifacts,
      localTest,
      markers,
      provider,
    });
    const checks = buildRoundChecks({
      result,
      localTest,
      artifacts,
      markers,
      seed,
      workspace,
    });
    const steps = buildStepResults({ checks, quality });
    const findings = buildFindings({ checks, quality, result });
    const correctnessPassed = [
      checks.replExited,
      checks.localTestsPass,
      checks.markersPresent,
      checks.reviewWritten,
      checks.usageDocsWritten,
      checks.roadmapWritten,
      checks.largeOutputArtifactWritten,
    ].every(Boolean);
    const stabilityPassed = [
      checks.sessionSaved,
      checks.compactRan,
      checks.noRepeatedRecoverableLoop,
      checks.noUnexpectedCrash,
    ].every(Boolean);
    const qualityPassed =
      quality.length > 0 &&
      average(quality.map((score) => score.score)) >= 3.5 &&
      quality.every((score) => score.score >= 3);

    return {
      round,
      domain: seed.domain,
      workspace,
      passed: correctnessPassed && stabilityPassed && qualityPassed,
      correctnessPassed,
      qualityPassed,
      stabilityPassed,
      durationMs: performance.now() - roundStarted,
      steps,
      checks,
      quality,
      findings,
      stdout: truncate(result.stdout, 16_000),
      stderr: truncate(result.stderr, 4_000),
      localTest,
    };
  } catch (error) {
    return {
      round,
      domain: seed.domain,
      workspace,
      passed: false,
      correctnessPassed: false,
      qualityPassed: false,
      stabilityPassed: false,
      durationMs: performance.now() - roundStarted,
      steps: [],
      checks: {},
      quality: [],
      findings: [
        {
          kind: "bug",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      stdout: "",
      stderr: "",
      localTest: { stdout: "", stderr: "", code: null },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRoundPrompts(
  round: number,
  seed: ProjectSeed,
  markers: Record<string, string>,
): string[] {
  return [
    [
      `Dogfood soak round ${round}. I am using you like a daily coding assistant on this ${seed.domain} project.`,
      "Inspect the real files with tools. Summarize the architecture, likely failure points, and a conservative fix plan.",
      "Do not edit files yet. Keep the answer under 220 words.",
      `End with ${markers.orient}.`,
    ].join(" "),
    [
      "Now run npm test, fix the failing implementation with minimal changes, and run npm test again.",
      "If the first attempt fails, inspect the error and recover instead of repeating the same command blindly.",
      "Avoid unrelated refactors and keep the public API stable.",
      `End with ${markers.fix}.`,
    ].join(" "),
    [
      "Write REVIEW.md as a pragmatic code review for this project.",
      "Include exactly 3 prioritized findings with file references, one practical follow-up, and no invented external systems.",
      `End your final response with ${markers.review}.`,
    ].join(" "),
    [
      "Create docs/usage.md for a teammate.",
      "Include a short API overview, two examples, edge cases, and how to run the tests.",
      "Keep it compact and grounded in the current files.",
      `End with ${markers.docs}.`,
    ].join(" "),
    [
      "I made a typo in the path. First try to read_file docs/usgae.md exactly.",
      "When that fails, recover by opening docs/usage.md and update it to include this exact sentence:",
      '"Runs offline; no network calls are required."',
      `End with ${markers.typo}.`,
    ].join(" "),
    [
      "Run this exact shell command to generate a large diagnostic output:",
      `node -e "process.stdout.write('SOAK_LONG_OUTPUT_R${round}\\\\n' + 'diagnostic line\\\\n'.repeat(6000))"`,
      "After the tool returns, mention whether the output was stored as an artifact.",
      `End with ${markers.artifact}.`,
    ].join(" "),
    [
      "Create ROADMAP.md comparing Option A: small cleanup and tests vs Option B: broad rewrite.",
      "Recommend one option for this actual project, with tradeoffs, risks, and next steps.",
      "This is a quality task, not a right/wrong task: be specific and avoid generic advice.",
      `End with ${markers.roadmap}.`,
    ].join(" "),
    "/cost",
    "/compact",
    [
      "After compaction, give a final status for this round.",
      "Include what changed, tests run, quality concerns, and remaining risks.",
      "Be honest if anything is uncertain and do not claim files you did not inspect.",
      `End with ${markers.final}.`,
    ].join(" "),
  ];
}

async function prepareWorkspace(workspace: string, seed: ProjectSeed): Promise<void> {
  for (const [path, content] of Object.entries(seed.files)) {
    const filePath = resolve(workspace, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

async function readRoundArtifacts(workspace: string): Promise<Record<string, string>> {
  const paths = [
    "README.md",
    "REVIEW.md",
    "ROADMAP.md",
    "docs/usage.md",
    "test.mjs",
    "package.json",
  ];
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = await readIfExists(resolve(workspace, path));
  }

  const sourceFiles = await listFiles(resolve(workspace, "src"));
  for (const path of sourceFiles) {
    files[`src/${path}`] = await readIfExists(resolve(workspace, "src", path));
  }
  files.__artifactFiles = (await listArtifactFiles(workspace)).join("\n");
  return files;
}

function buildRoundChecks(input: {
  result: CliRunResult;
  localTest: LocalCommandResult;
  artifacts: Record<string, string>;
  markers: Record<string, string>;
  seed: ProjectSeed;
  workspace: string;
}): Record<string, boolean> {
  const stdout = input.result.stdout;
  const markersPresent = Object.values(input.markers).every((marker) =>
    stdout.includes(marker),
  );
  return {
    replExited: input.result.code === 0,
    localTestsPass:
      input.localTest.code === 0 && input.localTest.stdout.includes(input.seed.passMarker),
    sawInitialTestFailure:
      stdout.includes("AssertionError") ||
      stdout.includes("CommandFailed") ||
      stdout.includes("notEqual") ||
      stdout.includes("expected"),
    ranNpmTestAtLeastTwice:
      countRunShellCommands(
        stdout,
        /(?:^|\s)(?:cmd(?:\.exe)?\s+\/c\s+)?npm(?:\.cmd)?\s+test(?:\s|$)/i,
      ) >= 2,
    markersPresent,
    reviewWritten: input.artifacts["REVIEW.md"].trim().length > 200,
    usageDocsWritten:
      input.artifacts["docs/usage.md"].includes("Runs offline; no network calls are required.") &&
      input.artifacts["docs/usage.md"].trim().length > 200,
    roadmapWritten: input.artifacts["ROADMAP.md"].trim().length > 250,
    largeOutputArtifactWritten: input.artifacts.__artifactFiles.includes(".txt"),
    sawTypoRecovery:
      stdout.includes("docs/usgae.md") &&
      (stdout.includes("FileNotFound") || stdout.includes("not found")),
    compactRan:
      stdout.includes("Compacted ") || stdout.includes("No compaction needed."),
    sessionSaved: existsSync(resolve(input.workspace, ".agent", "sessions")),
    noRepeatedRecoverableLoop: !stdout.includes("Retry chain limit reached"),
    noUnexpectedCrash:
      input.result.stderr.trim().length === 0 ||
      !/Unexpected error|Unhandled|stack/i.test(input.result.stderr),
  };
}

function buildStepResults(input: {
  checks: Record<string, boolean>;
  quality: QualityScore[];
}): StepResult[] {
  return [
    step("orientation and planning", {
      markersPresent: input.checks.markersPresent,
      quality: (input.quality.find((score) => score.target === "orientation")?.score ?? 0) >= 3,
    }),
    step("implementation and tests", {
      localTestsPass: input.checks.localTestsPass,
      ranNpmTestAtLeastTwice: input.checks.ranNpmTestAtLeastTwice,
    }),
    step("review artifact quality", {
      reviewWritten: input.checks.reviewWritten,
      quality: (input.quality.find((score) => score.target === "REVIEW.md")?.score ?? 0) >= 3,
    }),
    step("usage docs and typo recovery", {
      usageDocsWritten: input.checks.usageDocsWritten,
      sawTypoRecovery: input.checks.sawTypoRecovery,
    }),
    step("large output artifact", {
      largeOutputArtifactWritten: input.checks.largeOutputArtifactWritten,
    }),
    step("roadmap quality", {
      roadmapWritten: input.checks.roadmapWritten,
      quality: (input.quality.find((score) => score.target === "ROADMAP.md")?.score ?? 0) >= 3,
    }),
    step("compact and final status", {
      compactRan: input.checks.compactRan,
      sessionSaved: input.checks.sessionSaved,
      noRepeatedRecoverableLoop: input.checks.noRepeatedRecoverableLoop,
    }),
  ];
}

function step(name: string, checks: Record<string, boolean>): StepResult {
  return {
    name,
    durationMs: 0,
    checks,
    findings: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([check]): Finding => ({ kind: "stability", message: `Failed check: ${check}` })),
  };
}

function buildFindings(input: {
  checks: Record<string, boolean>;
  quality: QualityScore[];
  result: CliRunResult;
}): Finding[] {
  const findings: Finding[] = [];
  const providerFailure =
    /Model provider request failed|status code (?:5\d\d|429)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/i.test(
      `${input.result.stdout}\n${input.result.stderr}`,
    );
  for (const [check, passed] of Object.entries(input.checks)) {
    if (!passed) {
      const kind: FindingKind =
        providerFailure
          ? "variance"
          : check.includes("quality") || check.includes("Written")
            ? "quality"
            : "bug";
      findings.push({ kind, message: `Required check failed: ${check}` });
    }
  }

  if (providerFailure) {
    findings.push({
      kind: "variance",
      message: "The round was interrupted by an upstream model/API failure.",
    });
  }

  for (const quality of input.quality) {
    if (quality.score < 4) {
      findings.push({
        kind: "quality",
        message: `${quality.target} scored ${quality.score}/5 (${quality.source}): ${quality.issues.join("; ") || "quality below target"}`,
      });
    }
  }

  if (input.result.stdout.includes("Approve tool?") && !input.result.stdout.includes("[tool]")) {
    findings.push({
      kind: "ux",
      message: "Approval prompt appeared without a visible follow-up tool result.",
    });
  }

  return findings;
}

async function scoreRoundQuality(input: {
  round: number;
  seed: ProjectSeed;
  stdout: string;
  artifacts: Record<string, string>;
  localTest: LocalCommandResult;
  markers: Record<string, string>;
  provider: ModelProvider | undefined;
}): Promise<QualityScore[]> {
  const orientation = extractAgentText(input.stdout, input.markers.orient);
  const finalStatus = extractAgentText(input.stdout, input.markers.final);
  const heuristic = [
    scoreContent({
      target: "orientation",
      content: orientation,
      requiredTerms: [input.seed.sourceFile, "test", "plan"],
      helpfulTerms: ["risk", "minimal", "current", ...input.seed.terms],
      bannedTerms: ["database", "kubernetes", "oauth", "cloud"],
      minLength: 120,
      maxLength: 1_800,
    }),
    scoreContent({
      target: "REVIEW.md",
      content: input.artifacts["REVIEW.md"],
      requiredTerms: [input.seed.sourceFile, "P1", "P2", "follow"],
      helpfulTerms: ["risk", "test", ...input.seed.terms],
      bannedTerms: ["database", "kubernetes", "microservice"],
      minLength: 220,
      maxLength: 2_500,
    }),
    scoreContent({
      target: "docs/usage.md",
      content: input.artifacts["docs/usage.md"],
      requiredTerms: ["example", "npm test", "Runs offline; no network calls are required."],
      helpfulTerms: input.seed.terms,
      bannedTerms: ["deploy", "cloud"],
      minLength: 220,
      maxLength: 2_500,
    }),
    scoreContent({
      target: "ROADMAP.md",
      content: input.artifacts["ROADMAP.md"],
      requiredTerms: ["Option A", "Option B", "recommend", "risk"],
      helpfulTerms: ["tradeoff", "test", ...input.seed.terms],
      bannedTerms: ["rewrite everything immediately"],
      minLength: 260,
      maxLength: 2_500,
    }),
    scoreContent({
      target: "final status",
      content: finalStatus,
      requiredTerms: ["test", "risk", input.seed.passMarker],
      helpfulTerms: ["changed", "remaining", ...input.seed.terms],
      bannedTerms: ["all production-ready", "guaranteed"],
      minLength: 120,
      maxLength: 1_800,
    }),
  ];

  if (!input.provider) {
    return heuristic;
  }

  try {
    const judged = await judgeQuality(input.provider, {
      round: input.round,
      domain: input.seed.domain,
      terms: input.seed.terms,
      sourceFile: input.seed.sourceFile,
      initialSource: input.seed.files[input.seed.sourceFile] ?? "",
      finalSource: input.artifacts[input.seed.sourceFile] ?? "",
      initialTest: input.seed.files["test.mjs"] ?? "",
      finalTest: input.artifacts["test.mjs"],
      localTest: input.localTest.stdout + input.localTest.stderr,
      toolHistory: extractToolHistory(input.stdout),
      orientation,
      review: input.artifacts["REVIEW.md"],
      usage: input.artifacts["docs/usage.md"],
      roadmap: input.artifacts["ROADMAP.md"],
      finalStatus,
    });
    return judged.length > 0 ? mergeQualityScores(heuristic, judged) : heuristic;
  } catch (error) {
    return [
      ...heuristic,
      {
        target: "quality judge",
        score: 3,
        source: "heuristic",
        positives: [],
        issues: [
          error instanceof Error ? error.message : `Judge failed: ${String(error)}`,
        ],
      },
    ];
  }
}

function mergeQualityScores(
  fallback: QualityScore[],
  preferred: QualityScore[],
): QualityScore[] {
  const preferredByTarget = new Map(
    preferred.map((score) => [score.target, score] as const),
  );
  return fallback.map((score) => preferredByTarget.get(score.target) ?? score);
}

async function judgeQuality(
  provider: ModelProvider,
  input: {
    round: number;
    domain: string;
    terms: string[];
    sourceFile: string;
    initialSource: string;
    finalSource: string;
    initialTest: string;
    finalTest: string;
    localTest: string;
    toolHistory: string;
    orientation: string;
    review: string;
    usage: string;
    roadmap: string;
    finalStatus: string;
  },
): Promise<QualityScore[]> {
  const response = await provider.createMessage({
    temperature: 0,
    maxOutputTokens: 1_200,
    messages: [
      {
        role: "system",
        content: [
          "You are a strict QA reviewer for an AI coding agent dogfood test.",
          "Score each artifact from 1 to 5 for groundedness, actionability, clarity, proportionality, and useful uncertainty.",
          "The orientation artifact was produced before the implementation fix, so judge it against initialSource and initialTest.",
          "Later artifacts and final status were produced after tool actions, so use finalSource, finalTest, localTest, and toolHistory as evidence.",
          "Do not penalize operational claims that are supported by toolHistory.",
          "Penalize hallucinated systems, vague advice, missing risks, and claims not grounded in the provided artifacts.",
          "Return only JSON with this shape:",
          '{"scores":[{"target":"orientation","score":4,"positives":["..."],"issues":["..."]}]}',
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          round: input.round,
          domain: input.domain,
          expectedTerms: input.terms,
          evidence: {
            sourceFile: input.sourceFile,
            initialSource: truncate(input.initialSource, 3_000),
            finalSource: truncate(input.finalSource, 3_000),
            initialTest: truncate(input.initialTest, 2_500),
            finalTest: truncate(input.finalTest, 2_500),
            localTest: truncate(input.localTest, 1_500),
            toolHistory: truncate(input.toolHistory, 5_000),
          },
          artifacts: {
            orientation: truncate(input.orientation, 2_500),
            "REVIEW.md": truncate(input.review, 3_000),
            "docs/usage.md": truncate(input.usage, 3_000),
            "ROADMAP.md": truncate(input.roadmap, 3_000),
            "final status": truncate(input.finalStatus, 2_500),
          },
        }),
      },
    ],
  });
  const parsed = parseJsonObject(response.content) as {
    scores?: Array<{
      target?: unknown;
      score?: unknown;
      positives?: unknown;
      issues?: unknown;
    }>;
  };

  return (parsed.scores ?? [])
    .map((score): QualityScore | undefined => {
      if (typeof score.target !== "string" || typeof score.score !== "number") {
        return undefined;
      }

      return {
        target: normalizeTarget(score.target),
        score: clampScore(score.score),
        source: "judge",
        positives: asStringArray(score.positives),
        issues: asStringArray(score.issues),
      };
    })
    .filter((score): score is QualityScore => Boolean(score));
}

function scoreContent(input: {
  target: string;
  content: string;
  requiredTerms: string[];
  helpfulTerms: string[];
  bannedTerms: string[];
  minLength: number;
  maxLength: number;
}): QualityScore {
  const lower = input.content.toLowerCase();
  const issues: string[] = [];
  const positives: string[] = [];
  let score = 5;

  if (input.content.trim().length < input.minLength) {
    score -= 1;
    issues.push("too short to be useful");
  }
  if (input.content.length > input.maxLength) {
    score -= 0.5;
    issues.push("longer than requested");
  }

  const missingRequired = input.requiredTerms.filter(
    (term) => !lower.includes(term.toLowerCase()),
  );
  if (missingRequired.length > 0) {
    score -= Math.min(2, missingRequired.length * 0.5);
    issues.push(`missing expected terms: ${missingRequired.join(", ")}`);
  } else {
    positives.push("covers required project-specific terms");
  }

  const helpfulHits = input.helpfulTerms.filter((term) =>
    lower.includes(term.toLowerCase()),
  );
  if (helpfulHits.length >= Math.min(2, input.helpfulTerms.length)) {
    positives.push("includes useful project-specific detail");
  } else {
    score -= 0.5;
    issues.push("light on project-specific detail");
  }

  const bannedHits = input.bannedTerms.filter((term) =>
    lower.includes(term.toLowerCase()),
  );
  if (bannedHits.length > 0) {
    score -= 1;
    issues.push(`possibly ungrounded terms: ${bannedHits.join(", ")}`);
  }

  return {
    target: input.target,
    score: clampScore(score),
    source: "heuristic",
    positives,
    issues,
  };
}

function runShannonScriptedRepl(input: {
  cwd: string;
  lines: string[];
  approvalAnswers: Array<"y" | "n" | "a">;
  defaultApprovalAnswer: "y" | "n" | "a";
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
    const approvalAnswers = [...input.approvalAnswers];
    let sentExit = false;
    let handledApprovalOffset = 0;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`shannon code soak timed out after ${input.timeoutMs}ms`));
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
        child.stdin!.write(`${approvalAnswers.shift() ?? input.defaultApprovalAnswer}\n`);
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

function runLocalCommand(input: {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<LocalCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", commandLine([input.command, ...input.args])], {
            cwd: input.cwd,
            env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${input.command} ${input.args.join(" ")} timed out`));
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

function createProjectSeed(round: number): ProjectSeed {
  const templates = [createTaskSeed, createReadingSeed, createLedgerSeed];
  return templates[(round - 1) % templates.length]!(round);
}

function createTaskSeed(round: number): ProjectSeed {
  const passMarker = `SOAK_TASK_TEST_PASS_R${round}`;
  return {
    domain: "task triage helper",
    slug: "task-triage",
    sourceFile: "src/tasks.mjs",
    passMarker,
    terms: ["task", "status", "overdue", "priority"],
    files: {
      "package.json": packageJson(),
      "README.md": [
        "# Task Triage Helper",
        "",
        "Small offline helper for normalizing tasks, summarizing status counts, and finding overdue work.",
        "",
      ].join("\n"),
      "src/tasks.mjs": [
        "export function normalizeTask(input) {",
        "  return {",
        "    id: input.id ?? `task-${Date.now()}`,",
        "    title: input.title,",
        "    status: input.status ?? 'todo',",
        "    priority: input.priority ?? 2,",
        "    tags: input.tags ?? [],",
        "    due: input.due,",
        "  };",
        "}",
        "",
        "export function summarizeByStatus(tasks) {",
        "  return { todo: tasks.length, doing: 0, done: 0 };",
        "}",
        "",
        "export function filterOverdue(tasks, today = '2026-06-02') {",
        "  return tasks.filter((task) => task.due && task.due > today);",
        "}",
        "",
      ].join("\n"),
      "test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { normalizeTask, summarizeByStatus, filterOverdue } from './src/tasks.mjs';",
        "",
        "const tasks = [",
        "  normalizeTask({ id: 'a', title: ' Ship report ', status: 'todo', due: '2026-05-30', tags: ['ops'] }),",
        "  normalizeTask({ id: 'b', title: 'Review PR', status: 'doing', due: '2026-06-05' }),",
        "  normalizeTask({ id: 'c', title: 'Archive notes', status: 'done', due: '2026-05-28' }),",
        "];",
        "",
        "assert.equal(tasks[0].title, 'Ship report');",
        "assert.deepEqual(summarizeByStatus(tasks), { todo: 1, doing: 1, done: 1 });",
        "assert.deepEqual(filterOverdue(tasks).map((task) => task.id), ['a']);",
        `console.log('${passMarker}');`,
        "",
      ].join("\n"),
    },
  };
}

function createReadingSeed(round: number): ProjectSeed {
  const passMarker = `SOAK_READING_TEST_PASS_R${round}`;
  return {
    domain: "reading list helper",
    slug: "reading-list",
    sourceFile: "src/library.mjs",
    passMarker,
    terms: ["book", "reading", "author", "unread"],
    files: {
      "package.json": packageJson(),
      "README.md": [
        "# Reading List Helper",
        "",
        "Small offline helper for normalizing books and reporting reading backlog.",
        "",
      ].join("\n"),
      "src/library.mjs": [
        "export function normalizeBook(input) {",
        "  return {",
        "    id: input.id ?? `book-${Date.now()}`,",
        "    title: input.title,",
        "    author: input.author,",
        "    status: input.status ?? 'unread',",
        "    pages: input.pages ?? 0,",
        "  };",
        "}",
        "",
        "export function unreadBooks(books) {",
        "  return books;",
        "}",
        "",
        "export function totalUnreadPages(books) {",
        "  return books.reduce((sum, book) => sum + book.pages, 0);",
        "}",
        "",
      ].join("\n"),
      "test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { normalizeBook, unreadBooks, totalUnreadPages } from './src/library.mjs';",
        "",
        "const books = [",
        "  normalizeBook({ id: 'one', title: ' Dune ', author: ' Frank Herbert ', status: 'unread', pages: 412 }),",
        "  normalizeBook({ id: 'two', title: 'A Wizard of Earthsea', author: 'Ursula K. Le Guin', status: 'reading', pages: 183 }),",
        "  normalizeBook({ id: 'three', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', status: 'done', pages: 304 }),",
        "];",
        "",
        "assert.equal(books[0].title, 'Dune');",
        "assert.equal(books[0].author, 'Frank Herbert');",
        "assert.deepEqual(unreadBooks(books).map((book) => book.id), ['one']);",
        "assert.equal(totalUnreadPages(books), 412);",
        `console.log('${passMarker}');`,
        "",
      ].join("\n"),
    },
  };
}

function createLedgerSeed(round: number): ProjectSeed {
  const passMarker = `SOAK_LEDGER_TEST_PASS_R${round}`;
  return {
    domain: "budget ledger helper",
    slug: "budget-ledger",
    sourceFile: "src/ledger.mjs",
    passMarker,
    terms: ["ledger", "expense", "income", "category"],
    files: {
      "package.json": packageJson(),
      "README.md": [
        "# Budget Ledger Helper",
        "",
        "Small offline helper for computing totals and category summaries from ledger entries.",
        "",
      ].join("\n"),
      "src/ledger.mjs": [
        "export function normalizeEntry(input) {",
        "  return {",
        "    id: input.id ?? `entry-${Date.now()}`,",
        "    category: input.category,",
        "    type: input.type,",
        "    amount: Number(input.amount),",
        "  };",
        "}",
        "",
        "export function netTotal(entries) {",
        "  return entries.reduce((sum, entry) => sum - entry.amount, 0);",
        "}",
        "",
        "export function totalByCategory(entries) {",
        "  const totals = {};",
        "  for (const entry of entries) {",
        "    totals[entry.category] = entry.amount;",
        "  }",
        "  return totals;",
        "}",
        "",
      ].join("\n"),
      "test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { normalizeEntry, netTotal, totalByCategory } from './src/ledger.mjs';",
        "",
        "const entries = [",
        "  normalizeEntry({ id: 'salary', category: 'income', type: 'income', amount: '5000' }),",
        "  normalizeEntry({ id: 'rent', category: 'housing', type: 'expense', amount: 1800 }),",
        "  normalizeEntry({ id: 'groceries', category: 'food', type: 'expense', amount: 120 }),",
        "  normalizeEntry({ id: 'market', category: 'food', type: 'expense', amount: 80 }),",
        "];",
        "",
        "assert.equal(netTotal(entries), 3000);",
        "assert.deepEqual(totalByCategory(entries), { income: 5000, housing: -1800, food: -200 });",
        `console.log('${passMarker}');`,
        "",
      ].join("\n"),
    },
  };
}

function packageJson(): string {
  return JSON.stringify({ type: "module", scripts: { test: "node test.mjs" } }, null, 2);
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

function npmCommand(): string {
  return "npm";
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

async function listFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
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

function extractAgentText(stdout: string, marker: string): string {
  const markerIndex = stdout.indexOf(marker);
  if (markerIndex === -1) {
    return "";
  }
  const prefix = stdout.slice(Math.max(0, markerIndex - 4_000), markerIndex + marker.length);
  const agentIndex = prefix.lastIndexOf("Agent >");
  return agentIndex === -1 ? prefix : prefix.slice(agentIndex);
}

function extractToolHistory(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith("[tool]") ||
        trimmed.startsWith("Permission request:") ||
        trimmed.startsWith("Compacted ") ||
        trimmed.startsWith("Saved session ") ||
        /SOAK_R\d+_[A-Z_]+_OK|SOAK_[A-Z_]+_TEST_PASS_R\d+/.test(trimmed)
      );
    })
    .join("\n");
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = value.indexOf(needle, index);
    if (next === -1) {
      return count;
    }
    count += 1;
    index = next + needle.length;
  }
}

function countRunShellCommands(stdout: string, matcher: RegExp): number {
  let count = 0;
  for (const match of stdout.matchAll(
    /\[tool\] run_shell input: \{"command":"((?:\\.|[^"\\])*)"/g,
  )) {
    const command = unescapeJsonSnippet(match[1] ?? "");
    if (matcher.test(command)) {
      count += 1;
    }
  }
  return count;
}

function unescapeJsonSnippet(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function parseRoundCount(value: string | undefined): number {
  const parsed = value ? Number(value) : 3;
  if (!Number.isInteger(parsed) || parsed < 2) {
    return 3;
  }
  return Math.min(parsed, 6);
}

function parseJsonObject(value: string): unknown {
  const trimmed = value.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  return JSON.parse(match?.[0] ?? trimmed);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeTarget(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("review")) return "REVIEW.md";
  if (lower.includes("usage")) return "docs/usage.md";
  if (lower.includes("roadmap")) return "ROADMAP.md";
  if (lower.includes("final")) return "final status";
  return "orientation";
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value * 10) / 10));
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated]`;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function formatMarkdownReport(summary: SoakSummary): string {
  const allQuality = summary.rounds.flatMap((round) => round.quality);
  const avgQuality = average(allQuality.map((score) => score.score));
  const findings = summary.rounds.flatMap((round) =>
    round.findings.map((finding) => ({ ...finding, round: round.round })),
  );

  return [
    "# Dogfood Soak Report",
    "",
    `Started: \`${summary.startedAt}\``,
    `Duration: \`${(summary.durationMs / 1000).toFixed(1)}s\``,
    `Model: \`${summary.model}\``,
    `Base URL: \`${summary.baseURL}\``,
    `Rounds requested: \`${summary.roundsRequested}\``,
    `Quality judge: \`${String(summary.qualityJudge)}\``,
    `Workspace root: \`${summary.tempRoot}\``,
    `Workspaces retained: \`${String(summary.retainedWorkspaces)}\``,
    "",
    `Overall: **${summary.passed ? "PASS" : "FAIL"}** (${summary.rounds.filter((round) => round.passed).length}/${summary.rounds.length} rounds)`,
    `Average quality score: **${avgQuality.toFixed(2)}/5**`,
    "",
    "## Round Summary",
    "",
    "| Round | Domain | Result | Correctness | Stability | Quality | Duration |",
    "| ---: | --- | --- | --- | --- | ---: | ---: |",
    ...summary.rounds.map((round) => {
      const roundQuality = average(round.quality.map((score) => score.score));
      return `| ${round.round} | ${escapeTable(round.domain)} | ${
        round.passed ? "PASS" : "FAIL"
      } | ${round.correctnessPassed ? "PASS" : "FAIL"} | ${
        round.stabilityPassed ? "PASS" : "FAIL"
      } | ${roundQuality.toFixed(2)} | ${round.durationMs.toFixed(0)}ms |`;
    }),
    "",
    "## Quality Scores",
    "",
    "| Round | Target | Source | Score | Issues |",
    "| ---: | --- | --- | ---: | --- |",
    ...summary.rounds.flatMap((round) =>
      round.quality.map(
        (score) =>
          `| ${round.round} | ${escapeTable(score.target)} | ${score.source} | ${
            score.score
          } | ${escapeTable(score.issues.join("; ") || "none")} |`,
      ),
    ),
    "",
    "## Findings",
    "",
    findings.length === 0
      ? "No soak findings were recorded."
      : findings
          .map(
            (finding) =>
              `- **${finding.kind}** round ${finding.round}: ${finding.message}`,
          )
          .join("\n"),
    "",
    "## Checks",
    "",
    ...summary.rounds.flatMap((round) => [
      `### Round ${round.round}: ${round.domain}`,
      "",
      `- Workspace: \`${round.workspace}\``,
      `- Local test code: \`${String(round.localTest.code)}\``,
      `- Checks: \`${JSON.stringify(round.checks)}\``,
      round.error ? `- Error: ${round.error}` : "",
      "",
    ]),
  ].join("\n");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
