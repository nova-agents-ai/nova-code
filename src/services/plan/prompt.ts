import { type PlanModeSnapshot, PlanModeStatusEnum } from "./types.ts";

const MAX_PLAN_CONTEXT_CHARS = 12_000;

/** 根据 Plan Mode 状态生成追加到 system prompt 的约束指令。 */
export function formatPlanModeSystemInstructions(snapshot: PlanModeSnapshot): string | undefined {
  switch (snapshot.status) {
    case PlanModeStatusEnum.INACTIVE:
      return undefined;
    case PlanModeStatusEnum.EXECUTING:
      return formatApprovedPlanInstructions(snapshot.approvedPlan);
    case PlanModeStatusEnum.PLANNING:
    case PlanModeStatusEnum.AWAITING_APPROVAL:
    case PlanModeStatusEnum.REJECTED:
      return formatPlanningInstructions(snapshot);
  }
}

function formatPlanningInstructions(snapshot: PlanModeSnapshot): string {
  const rejection = formatRejection(snapshot);
  return [
    "<plan_mode>",
    "Plan Mode is active. The user has asked you to plan before implementation.",
    "You MUST NOT modify files, run Bash, change configuration, install dependencies, commit, or perform other write/mutating actions before the plan is approved.",
    "Use read-only tools such as LS, FileRead, Grep, Glob, WebFetch, WebSearch, Skill, and read-only Agent subagents to understand the codebase.",
    "When the plan is complete, call ExitPlanMode with a concrete implementation plan. Do not ask for plan approval in plain text.",
    rejection,
    "</plan_mode>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatApprovedPlanInstructions(plan: string | undefined): string | undefined {
  if (plan === undefined || plan.trim() === "") return undefined;
  return [
    "<approved_plan>",
    "The user approved the following plan. Treat it as a hard constraint while implementing; ask before making materially different changes.",
    truncatePlan(plan),
    "</approved_plan>",
  ].join("\n");
}

function formatRejection(snapshot: PlanModeSnapshot): string {
  if (snapshot.status !== PlanModeStatusEnum.REJECTED) return "";
  const feedback = snapshot.rejectionFeedback?.trim();
  if (feedback === undefined || feedback === "") {
    return "The previous plan was rejected. Revise the plan and call ExitPlanMode again.";
  }
  return `The previous plan was rejected with feedback: ${feedback}`;
}

function truncatePlan(plan: string): string {
  if (plan.length <= MAX_PLAN_CONTEXT_CHARS) return plan;
  return `${plan.slice(0, MAX_PLAN_CONTEXT_CHARS)}\n[truncated: approved plan exceeded ${MAX_PLAN_CONTEXT_CHARS} characters]`;
}
