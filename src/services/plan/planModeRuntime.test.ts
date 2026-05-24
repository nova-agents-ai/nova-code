import { describe, expect, test } from "bun:test";
import type { PermissionMode } from "../../types/permissions.ts";
import { createPlanModeRuntime } from "./planModeRuntime.ts";
import { type PlanApprovalProvider, PlanModeStatusEnum } from "./types.ts";

describe("createPlanModeRuntime", () => {
  test("enter 后有效权限模式变为 plan，并注入 planning system instructions", () => {
    const modes: PermissionMode[] = [];
    const runtime = createPlanModeRuntime({
      initialPermissionMode: "acceptEdits",
      onPermissionModeChange: (mode) => modes.push(mode),
    });

    runtime.enter({ previousPermissionMode: "acceptEdits" });

    expect(runtime.getSnapshot().status).toBe(PlanModeStatusEnum.PLANNING);
    expect(runtime.getEffectivePermissionMode("acceptEdits")).toBe("plan");
    expect(runtime.getSystemInstructions()).toContain("Plan Mode is active");
    expect(modes).toEqual(["plan"]);
  });

  test("submitPlan approved 后恢复进入前权限模式，并把 approved plan 注入 system", async () => {
    const modes: PermissionMode[] = [];
    const runtime = createPlanModeRuntime({
      approvalProvider: makeProvider("approved"),
      onPermissionModeChange: (mode) => modes.push(mode),
    });

    runtime.enter({ previousPermissionMode: "acceptEdits" });
    const result = await runtime.submitPlan("1. edit code\n2. run tests");

    expect(result.approval.decision).toBe("approved");
    expect(runtime.getSnapshot().status).toBe(PlanModeStatusEnum.EXECUTING);
    expect(runtime.getEffectivePermissionMode("plan")).toBe("acceptEdits");
    expect(runtime.getSystemInstructions()).toContain("<approved_plan>");
    expect(modes).toEqual(["plan", "acceptEdits"]);
  });

  test("submitPlan rejected 后保持 plan 权限模式，允许后续重提计划", async () => {
    const runtime = createPlanModeRuntime({
      approvalProvider: makeProvider("rejected", "too broad"),
    });

    runtime.enter({ previousPermissionMode: "default" });
    const result = await runtime.submitPlan("change everything");

    expect(result.approval.decision).toBe("rejected");
    expect(runtime.getSnapshot().status).toBe(PlanModeStatusEnum.REJECTED);
    expect(runtime.getEffectivePermissionMode("default")).toBe("plan");
    expect(runtime.getSystemInstructions()).toContain("too broad");
  });
});

function makeProvider(decision: "approved" | "rejected", feedback?: string): PlanApprovalProvider {
  return {
    requestPlanApproval: async () => ({
      decision,
      ...(feedback !== undefined ? { feedback } : {}),
    }),
  };
}
