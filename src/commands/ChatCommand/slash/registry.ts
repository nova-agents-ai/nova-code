/**
 * Slash 命令注册表 —— 聚合所有内置斜杠命令，提供按名查找。
 *
 * /help 命令通过工厂注入"当前 registry"，避免 help.ts ↔ registry.ts 的循环引用。
 */

import { clearCommand } from "./clear.ts";
import { compactCommand } from "./compact.ts";
import { exitCommand } from "./exit.ts";
import { makeHelpCommand } from "./help.ts";
import { loadCommand } from "./load.ts";
import { permissionsCommand } from "./permissions.ts";
import { saveCommand } from "./save.ts";
import type { SlashCommand } from "./types.ts";

// 先构造非 help 的命令数组；help 通过工厂反向拿到“全部命令（含 help 自身）”
const nonHelpCommands: readonly SlashCommand[] = [
  clearCommand,
  exitCommand,
  saveCommand,
  loadCommand,
  permissionsCommand,
  compactCommand,
];

// getter 闭包：保证 help 拿到的是整份 builtinSlashCommands（含 help）
const helpCommand = makeHelpCommand(() => builtinSlashCommands);

/**
 * 全体内置斜杠命令。展示顺序 = /help 列出的顺序。
 *
 * 顺序选择：常用的 clear/exit 前置，save/load 中段（数据持久化），
 * help 最后——符合用户直觉（help 通常不靠上扫）。
 */
export const builtinSlashCommands: readonly SlashCommand[] = [...nonHelpCommands, helpCommand];

/**
 * 按名查找斜杠命令。name 不带 `/` 前缀。找不到返回 undefined。
 *
 * 查找用线性扫：命令不到 10 条，Map 构建反而复杂。
 */
export function findSlashCommand(name: string): SlashCommand | undefined {
  for (const cmd of builtinSlashCommands) {
    if (cmd.name === name) return cmd;
  }
  return undefined;
}
