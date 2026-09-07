import { exec } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentRunResult } from "../core/agent.js";
import type { EvalAssertion } from "./case.js";

const execAsync = promisify(exec);

export interface EvalAssertionContext {
  cwd: string;
  result: AgentRunResult;
}

export interface EvalAssertionResult {
  type: EvalAssertion["type"];
  passed: boolean;
  message: string;
}

export async function runEvalAssertions(input: {
  assertions: EvalAssertion[];
  context: EvalAssertionContext;
}): Promise<EvalAssertionResult[]> {
  const results: EvalAssertionResult[] = [];
  for (const assertion of input.assertions) {
    results.push(await runEvalAssertion(assertion, input.context));
  }
  return results;
}

export async function runEvalAssertion(
  assertion: EvalAssertion,
  context: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  try {
    switch (assertion.type) {
      case "file_exists":
        await access(resolveWorkspacePath(context.cwd, assertion.path));
        return pass(assertion.type, `File exists: ${assertion.path}`);
      case "file_contains": {
        const content = await readFile(resolveWorkspacePath(context.cwd, assertion.path), "utf8");
        return content.includes(assertion.text)
          ? pass(assertion.type, `File contains expected text: ${assertion.path}`)
          : fail(assertion.type, `File ${assertion.path} did not contain ${JSON.stringify(assertion.text)}.`);
      }
      case "file_not_contains": {
        let content = "";
        try {
          content = await readFile(resolveWorkspacePath(context.cwd, assertion.path), "utf8");
        } catch {
          return pass(assertion.type, `File is absent and therefore does not contain text: ${assertion.path}`);
        }
        return !content.includes(assertion.text)
          ? pass(assertion.type, `File does not contain forbidden text: ${assertion.path}`)
          : fail(assertion.type, `File ${assertion.path} contained forbidden text ${JSON.stringify(assertion.text)}.`);
      }
      case "command_succeeds":
        await execAsync(assertion.command, {
          cwd: context.cwd,
          windowsHide: true,
          timeout: 30_000,
        });
        return pass(assertion.type, `Command succeeded: ${assertion.command}`);
      case "stdout_contains": {
        const { stdout } = await execAsync(assertion.command, {
          cwd: context.cwd,
          windowsHide: true,
          timeout: 30_000,
        });
        return stdout.includes(assertion.text)
          ? pass(assertion.type, `Command stdout contained expected text: ${assertion.command}`)
          : fail(assertion.type, `Command stdout did not contain ${JSON.stringify(assertion.text)}.`);
      }
      case "session_contains": {
        const session = formatSession(context.result);
        return session.includes(assertion.text)
          ? pass(assertion.type, `Session contained expected text.`)
          : fail(assertion.type, `Session did not contain ${JSON.stringify(assertion.text)}.`);
      }
      case "tool_called": {
        const called = context.result.toolResults.some(
          (entry) => entry.toolCall.name === assertion.name,
        );
        return called
          ? pass(assertion.type, `Tool was called: ${assertion.name}`)
          : fail(assertion.type, `Tool was not called: ${assertion.name}`);
      }
      case "tool_not_called": {
        const called = context.result.toolResults.some(
          (entry) => entry.toolCall.name === assertion.name,
        );
        return !called
          ? pass(assertion.type, `Tool was not called: ${assertion.name}`)
          : fail(assertion.type, `Tool was unexpectedly called: ${assertion.name}`);
      }
    }
  } catch (error) {
    return fail(
      assertion.type,
      error instanceof Error ? error.message : "Assertion failed with non-Error.",
    );
  }
}

function pass(type: EvalAssertion["type"], message: string): EvalAssertionResult {
  return { type, passed: true, message };
}

function fail(type: EvalAssertion["type"], message: string): EvalAssertionResult {
  return { type, passed: false, message };
}

function resolveWorkspacePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function formatSession(result: AgentRunResult): string {
  return [
    result.content,
    ...result.messages.map((message) => message.content),
    ...result.toolResults.map((entry) => JSON.stringify(entry.result)),
  ].join("\n");
}
