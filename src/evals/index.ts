#!/usr/bin/env node
import { resolve } from "node:path";
import { runEvalSuite } from "./runner.js";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const projectRoot = process.cwd();
  const suite = await runEvalSuite({
    projectRoot,
    casesDir: resolve(projectRoot, "evals", "cases"),
    outputJsonPath: resolve(projectRoot, "eval-report.json"),
    outputMarkdownPath: resolve(projectRoot, "eval-report.md"),
    useRealProvider: args.has("--real"),
    keepWorkspaces: args.has("--keep-workspaces"),
  });

  console.log(
    `Eval ${suite.passed ? "PASS" : "FAIL"}: ${suite.passedCount}/${suite.total} cases passed.`,
  );
  console.log("Reports: eval-report.json, eval-report.md");

  if (!suite.passed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

