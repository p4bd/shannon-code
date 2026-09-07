import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type PlanStatus = "pending" | "approved" | "executed" | "canceled";

export interface StoredPlan {
  id: string;
  sessionId: string;
  task: string;
  content: string;
  status: PlanStatus;
  path: string;
  createdAt: string;
  updatedAt: string;
  executionMode: string;
}

export class PlanStore {
  private readonly plansDir: string;

  constructor(private readonly cwd: string) {
    this.plansDir = resolve(cwd, ".agent", "plans");
  }

  async createPlan(input: {
    sessionId: string;
    task: string;
    content: string;
    executionMode: string;
  }): Promise<StoredPlan> {
    await mkdir(this.plansDir, { recursive: true });
    const now = new Date().toISOString();
    const id = createPlanId(input.task, now);
    const path = `.agent/plans/${id}.md`;
    const plan: StoredPlan = {
      id,
      sessionId: input.sessionId,
      task: input.task,
      content: input.content.trim(),
      status: "pending",
      path,
      createdAt: now,
      updatedAt: now,
      executionMode: input.executionMode,
    };
    await this.writePlan(plan);
    return plan;
  }

  async updateStatus(plan: StoredPlan, status: PlanStatus): Promise<StoredPlan> {
    const updated: StoredPlan = {
      ...plan,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.writePlan(updated);
    return updated;
  }

  async loadPlan(path: string): Promise<string> {
    return readFile(resolve(this.cwd, path), "utf8");
  }

  private async writePlan(plan: StoredPlan): Promise<void> {
    await mkdir(this.plansDir, { recursive: true });
    await writeFile(resolve(this.cwd, plan.path), formatPlanFile(plan), "utf8");
  }
}

export function buildPlanPrompt(task: string): string {
  return [
    "Create an execution plan for the task below.",
    "Do not modify project files. Use read-only tools only if you need to inspect the workspace.",
    "Return a practical markdown plan with:",
    "- goal",
    "- files or areas to inspect/change",
    "- step-by-step implementation approach",
    "- verification commands",
    "- risks or open questions",
    "",
    `Task:\n${task.trim()}`,
  ].join("\n");
}

export function buildPlanRevisionPrompt(plan: StoredPlan, feedback: string): string {
  return [
    "Revise the existing execution plan using the feedback below.",
    "Do not modify project files. Use read-only tools only if needed.",
    "",
    `Original task:\n${plan.task}`,
    "",
    `Current plan:\n${plan.content}`,
    "",
    `Revision feedback:\n${feedback.trim()}`,
  ].join("\n");
}

export function buildPlanExecutionPrompt(plan: StoredPlan): string {
  return [
    `Execute the approved plan saved at ${plan.path}.`,
    "Follow the plan unless current workspace facts require a small adjustment.",
    "Keep changes scoped and verify the result.",
    "",
    `Original task:\n${plan.task}`,
    "",
    `Approved plan:\n${plan.content}`,
  ].join("\n");
}

function formatPlanFile(plan: StoredPlan): string {
  return [
    "---",
    `id: ${plan.id}`,
    `sessionId: ${plan.sessionId}`,
    `status: ${plan.status}`,
    `createdAt: ${plan.createdAt}`,
    `updatedAt: ${plan.updatedAt}`,
    `executionMode: ${plan.executionMode}`,
    "---",
    "",
    `# Plan: ${plan.task}`,
    "",
    plan.content,
    "",
  ].join("\n");
}

function createPlanId(task: string, isoDate: string): string {
  const timestamp = isoDate.replace(/[-:.TZ]/g, "").slice(0, 14);
  const slug =
    task
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "plan";
  return `${timestamp}_${slug}`;
}
