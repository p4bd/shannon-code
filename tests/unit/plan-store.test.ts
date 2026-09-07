import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPlanExecutionPrompt,
  buildPlanPrompt,
  buildPlanRevisionPrompt,
  PlanStore,
} from "../../src/plan/store.js";

describe("PlanStore", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "shannon-plan-store-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("creates traceable plan files and updates status", async () => {
    const store = new PlanStore(workspace);
    const plan = await store.createPlan({
      sessionId: "session-1",
      task: "Add tests",
      content: "1. Inspect tests\n2. Add coverage",
      executionMode: "default",
    });

    expect(plan.path).toMatch(/^\.agent\/plans\/.*add-tests\.md$/i);
    expect(await readFile(join(workspace, plan.path), "utf8")).toContain(
      "status: pending",
    );

    const approved = await store.updateStatus(plan, "approved");
    expect(await readFile(join(workspace, approved.path), "utf8")).toContain(
      "status: approved",
    );
  });

  it("builds plan prompts", async () => {
    const store = new PlanStore(workspace);
    const plan = await store.createPlan({
      sessionId: "session-1",
      task: "Add tests",
      content: "Use vitest",
      executionMode: "acceptEdits",
    });

    expect(buildPlanPrompt("Add tests")).toContain("Use read-only tools only");
    expect(buildPlanRevisionPrompt(plan, "Add typecheck")).toContain(
      "Revision feedback",
    );
    expect(buildPlanExecutionPrompt(plan)).toContain("Execute the approved plan");
  });
});
