import { describe, expect, test } from "bun:test";
import { createPlanModeRuntime, PlanModeStatusEnum } from "../../../services/plan/index.ts";
import type { PermissionMode } from "../../../types/permissions.ts";
import { planCommand } from "./plan.ts";
import type { PermissionModeRef, SlashContext, SlashIO } from "./types.ts";

function makeIO(): { readonly io: SlashIO; readonly output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      print: (text) => output.push(text),
      confirm: async () => false,
    },
  };
}

function makeModeRef(initial: PermissionMode = "default"): {
  readonly ref: PermissionModeRef;
  readonly state: { current: PermissionMode };
} {
  const state = { current: initial };
  return {
    state,
    ref: {
      get: () => state.current,
      set: (mode) => {
        state.current = mode;
      },
    },
  };
}

function makeContext(params: {
  readonly io: SlashIO;
  readonly args?: readonly string[];
  readonly modeRef?: PermissionModeRef;
  readonly runtime?: ReturnType<typeof createPlanModeRuntime>;
}): SlashContext {
  return {
    session: {} as SlashContext["session"],
    io: params.io,
    args: params.args ?? [],
    ...(params.modeRef !== undefined ? { permissionModeRef: params.modeRef } : {}),
    ...(params.runtime !== undefined ? { planModeRuntime: params.runtime } : {}),
  };
}

describe("planCommand", () => {
  test("/plan 进入 Plan Mode 并切换权限模式", async () => {
    const { io, output } = makeIO();
    const { ref, state } = makeModeRef("acceptEdits");
    const runtime = createPlanModeRuntime();

    const result = await planCommand.run(makeContext({ io, modeRef: ref, runtime }));

    expect(result.action).toBe("continue");
    expect(state.current).toBe("plan");
    expect(runtime.getSnapshot().status).toBe(PlanModeStatusEnum.PLANNING);
    expect(runtime.getSnapshot().previousPermissionMode).toBe("acceptEdits");
    expect(output.join("")).toContain("已进入 Plan Mode");
  });

  test("/plan <prompt> 进入 Plan Mode 并把 prompt 交回 REPL 提交", async () => {
    const { io } = makeIO();
    const { ref } = makeModeRef("default");
    const runtime = createPlanModeRuntime();

    const result = await planCommand.run(
      makeContext({ io, modeRef: ref, runtime, args: ["implement", "auth"] }),
    );

    expect(result).toEqual({ action: "submit", input: "implement auth" });
    expect(runtime.getSnapshot().status).toBe(PlanModeStatusEnum.PLANNING);
  });

  test("/plan status 展示当前状态", async () => {
    const { io, output } = makeIO();
    const { ref } = makeModeRef("default");
    const runtime = createPlanModeRuntime();

    await planCommand.run(makeContext({ io, modeRef: ref, runtime, args: ["status"] }));

    expect(output.join("")).toContain("Plan Mode 状态：inactive");
  });
});
