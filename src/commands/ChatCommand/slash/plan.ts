import { type PlanModeSnapshot, PlanModeStatusEnum } from "../../../services/plan/index.ts";
import type { PermissionMode } from "../../../types/permissions.ts";
import type { SlashCommand } from "./types.ts";

export const planCommand: SlashCommand = {
  name: "plan",
  description: "进入/查看 Plan Mode：先计划，经批准后再执行",
  usage:
    "/plan                         进入 Plan Mode 或查看当前 plan 状态\n" +
    "/plan <prompt>                进入 Plan Mode，并把 prompt 作为本轮需求提交给模型\n" +
    "/plan status                  查看 Plan Mode 状态",
  async run(ctx) {
    const { io, args, permissionModeRef, planModeRuntime } = ctx;
    if (permissionModeRef === undefined || planModeRuntime === undefined) {
      io.print("Plan Mode 未启用（缺少 permissionModeRef 或 planModeRuntime）。\n");
      return { action: "continue" };
    }

    const prompt = args.join(" ").trim();
    if (prompt === "status") {
      io.print(formatPlanStatus(planModeRuntime.getSnapshot()));
      return { action: "continue" };
    }

    const snapshot = planModeRuntime.getSnapshot();
    if (prompt === "" && snapshot.status !== PlanModeStatusEnum.INACTIVE) {
      io.print(formatPlanStatus(snapshot));
      return { action: "continue" };
    }

    const previousMode = getPreviousPermissionMode(permissionModeRef.get());
    planModeRuntime.enter({ previousPermissionMode: previousMode });
    permissionModeRef.set("plan");
    io.print("已进入 Plan Mode。批准 plan 前，Bash/FileWrite/FileEdit 会被拦截。\n");

    if (prompt === "") return { action: "continue" };
    return { action: "submit", input: prompt };
  },
};

function getPreviousPermissionMode(mode: PermissionMode): PermissionMode {
  return mode === "plan" ? "default" : mode;
}

function formatPlanStatus(snapshot: PlanModeSnapshot): string {
  const lines = [`Plan Mode 状态：${snapshot.status}`];
  lines.push(`批准后恢复权限模式：${snapshot.previousPermissionMode}`);
  appendPlanLine(lines, "已批准 plan", snapshot.approvedPlan);
  appendPlanLine(lines, "待审批 plan", snapshot.pendingPlan);
  appendPlanLine(lines, "已拒绝 plan", snapshot.rejectedPlan);
  if (snapshot.rejectionFeedback !== undefined) {
    lines.push(`拒绝反馈：${snapshot.rejectionFeedback}`);
  }
  return `${lines.join("\n")}\n`;
}

function appendPlanLine(lines: string[], label: string, plan: string | undefined): void {
  if (plan === undefined || plan.trim() === "") return;
  lines.push(`${label}：${truncatePlan(plan)}`);
}

function truncatePlan(plan: string): string {
  const max = 800;
  if (plan.length <= max) return plan;
  return `${plan.slice(0, max)}\n[truncated at ${max} chars]`;
}
