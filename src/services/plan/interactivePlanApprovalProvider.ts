import type { PlanApprovalProvider, PlanApprovalResult } from "./types.ts";

export interface InteractivePlanApprovalProviderDeps {
  readonly write: (text: string) => void;
  readonly readLine: (prompt: string) => Promise<string | null>;
}

/** chat REPL 使用的 ExitPlanMode 审批 provider。 */
export function createInteractivePlanApprovalProvider(
  deps: InteractivePlanApprovalProviderDeps,
): PlanApprovalProvider {
  return {
    requestPlanApproval: async (request): Promise<PlanApprovalResult> => {
      deps.write(formatPlanForReview(request.plan));
      const answer = await deps.readLine("[plan] Approve this plan? (y/n) ");
      return isYes(answer) ? { decision: "approved" } : { decision: "rejected" };
    },
  };
}

function formatPlanForReview(plan: string): string {
  return [
    "",
    "[plan] Proposed implementation plan:",
    "────────────────────────────────────────",
    plan,
    "────────────────────────────────────────",
  ].join("\n");
}

function isYes(answer: string | null): boolean {
  if (answer === null) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
