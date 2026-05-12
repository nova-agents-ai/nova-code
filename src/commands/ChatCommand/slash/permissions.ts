/**
 * /permissions 斜杠命令 —— 在 REPL 里查看和切换权限系统状态。
 *
 * 子命令：
 *   /permissions                       → 等价 /permissions list
 *   /permissions list                  → 列出 session/project/global 三层规则
 *   /permissions mode                  → 显示当前权限模式
 *   /permissions mode <m>              → 切换当前模式
 *       m ∈ {default, acceptEdits, bypassPermissions, plan}
 *
 * 设计选择：
 *   - 不支持 `/permissions add`：规则的增加走交互式 5 档菜单（allow-once/session/project/global）
 *     更安全直观；手工 add 容易写错 rule 语法
 *   - 不支持 `/permissions remove`：第一版保持最小表面积
 *   - permissionStore/permissionModeRef 未注入时，命令给出明确提示并 continue，不报错
 */

import type { PermissionMode, PermissionRuleWithSource } from "../../../types/permissions.ts";
import type { SlashCommand } from "./types.ts";

const VALID_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

export const permissionsCommand: SlashCommand = {
  name: "permissions",
  description: "查看/切换权限模式、列出三层规则",
  usage:
    "/permissions [list]            列出 session/project/global 规则\n" +
    "/permissions mode              显示当前权限模式\n" +
    "/permissions mode <m>          切换模式 (default|acceptEdits|bypassPermissions|plan)",
  async run(ctx) {
    const { io, args, permissionStore, permissionModeRef } = ctx;
    const sub = args[0] ?? "list";

    if (sub === "list") {
      if (permissionStore === undefined) {
        io.print("权限系统未启用（permissionStore 未注入）。\n");
        return { action: "continue" };
      }
      printRules(io, permissionStore.getMergedRules());
      return { action: "continue" };
    }

    if (sub === "mode") {
      if (permissionModeRef === undefined) {
        io.print("权限系统未启用（permissionModeRef 未注入）。\n");
        return { action: "continue" };
      }
      const next = args[1];
      if (next === undefined || next === "") {
        io.print(`当前模式：${permissionModeRef.get()}\n`);
        return { action: "continue" };
      }
      if (!isValidMode(next)) {
        io.print(`未知模式 "${next}"。合法值：${VALID_MODES.join(" | ")}\n`);
        return { action: "continue" };
      }
      const prev = permissionModeRef.get();
      permissionModeRef.set(next);
      io.print(`权限模式：${prev} → ${next}\n`);
      return { action: "continue" };
    }

    io.print(`未知子命令 "${sub}"。\n${this.usage}\n`);
    return { action: "continue" };
  },
};

/** 按 source 分组打印规则；空层显示 "(none)"。 */
function printRules(
  io: { print: (text: string) => void },
  rules: readonly PermissionRuleWithSource[],
): void {
  const bySource: Record<string, PermissionRuleWithSource[]> = {
    session: [],
    project: [],
    global: [],
  };
  for (const r of rules) {
    // 每层都已初始化，非空检查是 readonly 类型安全的形式
    const bucket = bySource[r.source];
    if (bucket !== undefined) bucket.push(r);
  }
  const lines: string[] = [];
  for (const source of ["session", "project", "global"] as const) {
    const items = bySource[source] ?? [];
    lines.push(`[${source}] (${items.length})`);
    if (items.length === 0) {
      lines.push("  (none)");
      continue;
    }
    for (const { rule } of items) {
      const content = rule.ruleContent === undefined ? "*" : rule.ruleContent;
      lines.push(`  ${rule.behavior.padEnd(5)} ${rule.toolName} ${content}`);
    }
  }
  io.print(`${lines.join("\n")}\n`);
}

function isValidMode(s: string): s is PermissionMode {
  return (VALID_MODES as readonly string[]).includes(s);
}
