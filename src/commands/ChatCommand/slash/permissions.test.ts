/**
 * /permissions 斜杠命令单测。
 *
 * 覆盖：
 *   - /permissions        → 默认 list，分层展示
 *   - /permissions list   → 同上；三层规则分组打印
 *   - /permissions mode   → 显示当前模式
 *   - /permissions mode <m> → 切换模式，触发 ref.set
 *   - 未知模式 → 提示合法值
 *   - 未知子命令 → 提示 usage
 *   - permissionStore 未注入 → 友善兜底
 */

import { describe, expect, test } from "bun:test";

import type { PermissionStore } from "../../../services/permissions/permissionStore.ts";
import type { PermissionMode, PermissionRuleWithSource } from "../../../types/permissions.ts";
import { permissionsCommand } from "./permissions.ts";
import type { PermissionModeRef, SlashContext, SlashIO } from "./types.ts";

function mkIO(): { io: SlashIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      print: (t) => output.push(t),
      confirm: async () => false,
    },
  };
}

function mkModeRef(initial: PermissionMode = "default"): {
  ref: PermissionModeRef;
  state: { current: PermissionMode };
} {
  const state = { current: initial };
  return {
    state,
    ref: {
      get: () => state.current,
      set: (m) => {
        state.current = m;
      },
    },
  };
}

function mkStore(rules: readonly PermissionRuleWithSource[]): PermissionStore {
  return {
    getMergedRules: () => rules,
  } as unknown as PermissionStore;
}

function mkCtx(partial: {
  args?: readonly string[];
  io?: SlashIO;
  store?: PermissionStore;
  modeRef?: PermissionModeRef;
}): SlashContext {
  return {
    session: {} as SlashContext["session"],
    io: partial.io ?? mkIO().io,
    args: partial.args ?? [],
    ...(partial.store !== undefined ? { permissionStore: partial.store } : {}),
    ...(partial.modeRef !== undefined ? { permissionModeRef: partial.modeRef } : {}),
  };
}

describe("permissionsCommand", () => {
  test("/permissions (无参) → 默认 list，分三层打印", async () => {
    const { io, output } = mkIO();
    const store = mkStore([
      { source: "session", rule: { toolName: "Bash", ruleContent: "ls:*", behavior: "allow" } },
      {
        source: "project",
        rule: { toolName: "FileWrite", ruleContent: "/tmp/a", behavior: "allow" },
      },
    ]);

    const result = await permissionsCommand.run(mkCtx({ io, store }));

    expect(result.action).toBe("continue");
    const text = output.join("");
    expect(text).toContain("[session] (1)");
    expect(text).toContain("Bash");
    expect(text).toContain("ls:*");
    expect(text).toContain("[project] (1)");
    expect(text).toContain("FileWrite");
    expect(text).toContain("[global] (0)");
    expect(text).toContain("(none)");
  });

  test("/permissions list 显式等价于无参", async () => {
    const { io, output } = mkIO();
    const store = mkStore([]);
    await permissionsCommand.run(mkCtx({ io, args: ["list"], store }));
    const text = output.join("");
    expect(text).toContain("[session] (0)");
    expect(text).toContain("[project] (0)");
    expect(text).toContain("[global] (0)");
  });

  test("list 下规则 ruleContent 为 undefined → 展示 '*'", async () => {
    const { io, output } = mkIO();
    const store = mkStore([
      { source: "global", rule: { toolName: "FileRead", behavior: "allow" } },
    ]);
    await permissionsCommand.run(mkCtx({ io, store }));
    const text = output.join("");
    expect(text).toContain("allow FileRead *");
  });

  test("list 下 permissionStore 未注入 → 友善提示，不抛", async () => {
    const { io, output } = mkIO();
    const result = await permissionsCommand.run(mkCtx({ io }));
    expect(result.action).toBe("continue");
    expect(output.join("")).toContain("权限系统未启用");
  });

  test("/permissions mode 无参 → 显示当前模式", async () => {
    const { io, output } = mkIO();
    const { ref } = mkModeRef("acceptEdits");
    await permissionsCommand.run(mkCtx({ io, args: ["mode"], modeRef: ref }));
    expect(output.join("")).toContain("当前模式：acceptEdits");
  });

  test("/permissions mode <m> → 调 ref.set 切换", async () => {
    const { io, output } = mkIO();
    const { ref, state } = mkModeRef("default");
    await permissionsCommand.run(mkCtx({ io, args: ["mode", "bypassPermissions"], modeRef: ref }));
    expect(state.current).toBe("bypassPermissions");
    expect(output.join("")).toContain("default → bypassPermissions");
  });

  test("/permissions mode <非法值> → 不切换，提示合法值", async () => {
    const { io, output } = mkIO();
    const { ref, state } = mkModeRef("default");
    await permissionsCommand.run(mkCtx({ io, args: ["mode", "yolo"], modeRef: ref }));
    expect(state.current).toBe("default");
    const text = output.join("");
    expect(text).toContain("未知模式");
    expect(text).toContain("default");
    expect(text).toContain("acceptEdits");
    expect(text).toContain("bypassPermissions");
    expect(text).toContain("plan");
  });

  test("mode 下 permissionModeRef 未注入 → 友善提示", async () => {
    const { io, output } = mkIO();
    await permissionsCommand.run(mkCtx({ io, args: ["mode"] }));
    expect(output.join("")).toContain("权限系统未启用");
  });

  test("未知子命令 → 打印 usage", async () => {
    const { io, output } = mkIO();
    const result = await permissionsCommand.run(mkCtx({ io, args: ["xyz"] }));
    expect(result.action).toBe("continue");
    const text = output.join("");
    expect(text).toContain("未知子命令");
    expect(text).toContain("xyz");
    expect(text).toContain("/permissions");
  });

  test("mode 所有 4 档都能切换成功", async () => {
    for (const m of ["default", "acceptEdits", "bypassPermissions", "plan"] as const) {
      const { io } = mkIO();
      const { ref, state } = mkModeRef("default");
      await permissionsCommand.run(mkCtx({ io, args: ["mode", m], modeRef: ref }));
      expect(state.current).toBe(m);
    }
  });
});
