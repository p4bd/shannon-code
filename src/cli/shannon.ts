#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../utils/env.js";

const [subcommand] = process.argv.slice(2);

if (subcommand === "code") {
  process.argv.splice(2, 1);
  await runCode();
} else if (subcommand === undefined) {
  await runCode();
} else if (subcommand === "--help" || subcommand === "-h") {
  console.log(`Usage:
  shannon code [options] "your prompt"
  shannon code [options]
  shannon --version

Run "shannon code --help" for coding agent options.`);
} else if (subcommand === "--version" || subcommand === "-v") {
  process.argv.splice(2, 1, "--version");
  await runCode();
} else {
  console.error(`Unknown shannon command: ${subcommand}`);
  console.error('Run "shannon code --help" for coding agent options.');
  process.exitCode = 1;
}

async function runCode(): Promise<void> {
  await loadShannonRootEnv();
  await import("./index.js");
}

async function loadShannonRootEnv(): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = resolve(dirname(currentFile), "../..");
  await loadDotEnv(packageRoot, { override: true });
}
