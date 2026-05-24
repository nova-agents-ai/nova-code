import type { Tool } from "../../Tool.ts";
import { EXIT_PLAN_MODE_TOOL_NAME } from "./constants.ts";

const MAX_PLAN_CHARS = 60_000;

export const ExitPlanModeTool: Tool = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description:
    "Use this only while Plan Mode is active and the implementation plan is ready. It presents the plan to the user for approval; implementation may start only after approval.",
  input_schema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "Concrete implementation plan for user approval, including files/modules to change, validation strategy, and notable risks.",
      },
    },
    required: ["plan"],
  },
  requiresApproval: false,
  execute: async (input, context) => {
    const runtime = context.planModeRuntime;
    if (runtime === undefined) {
      throw new Error("Plan Mode runtime is not available in this execution context.");
    }
    const plan = parsePlan(input["plan"]);
    const result = await runtime.submitPlan(plan);
    if (result.approval.decision === "approved") {
      return formatApprovedResult(result.snapshot.approvedPlan ?? plan);
    }
    return formatRejectedResult(result.approval.feedback);
  },
};

function parsePlan(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("ExitPlanMode input field 'plan' must be a non-empty string.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PLAN_CHARS) {
    throw new Error(
      `ExitPlanMode input field 'plan' must be at most ${MAX_PLAN_CHARS} characters.`,
    );
  }
  return trimmed;
}

function formatApprovedResult(plan: string): string {
  return [
    "User approved exiting Plan Mode. You may now proceed with implementation.",
    "",
    "<approved_plan>",
    plan,
    "</approved_plan>",
  ].join("\n");
}

function formatRejectedResult(feedback: string | undefined): string {
  const suffix =
    feedback === undefined || feedback.trim() === "" ? "" : ` Feedback: ${feedback.trim()}`;
  return `User rejected the plan. Stay in Plan Mode, revise the plan, and call ExitPlanMode again.${suffix}`;
}
