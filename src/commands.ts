/**
 * 内置命令集的聚合入口。
 *
 * 与 claude-code 的同名文件保持一致的模式：具体命令实现按目录下沉到 src/commands/，
 * 本文件只负责"把它们串起来 + 提供 findCommand 查询"。
 *
 * 历史上这里装着 hello/ask 命令的完整实现（含 debug sink、flag 解析等），
 * M1.5 阶段按主题拆成了子目录；后期追加 chat 命令。对外导出的公共 API 保持不变：
 *   - CommandHandler / CommandDefinition：类型
 *   - builtinCommands / findCommand：命令集合与查找
 *   - buildDebugLogFileName / formatDebugPayload / parseAskFlags：仍作为兼容 re-export
 */

import { askCommand } from "./commands/AskCommand/AskCommand.ts";
import { chatCommand } from "./commands/ChatCommand/ChatCommand.ts";
import { configCommand } from "./commands/ConfigCommand/ConfigCommand.ts";
import { costCommand } from "./commands/CostCommand/CostCommand.ts";
import { helloCommand } from "./commands/HelloCommand/HelloCommand.ts";
import { initCommand } from "./commands/InitCommand/InitCommand.ts";
import { mcpCommand } from "./commands/McpCommand/McpCommand.ts";
import type { CommandDefinition } from "./commands/types.ts";

// 兼容 re-export：历史调用方（如 commands.test.ts）直接从本文件按名引用这些 helper，
// 保留顶层出口避免无意义的大范围 import 改动。
export {
  buildDebugLogFileName,
  formatDebugPayload,
} from "./commands/AskCommand/debugSink.ts";
export { parseAskFlags } from "./commands/AskCommand/parseAskFlags.ts";
export type { CommandDefinition, CommandHandler } from "./commands/types.ts";

export const builtinCommands: readonly CommandDefinition[] = [
  helloCommand,
  askCommand,
  chatCommand,
  costCommand,
  configCommand,
  initCommand,
  mcpCommand,
];

/**
 * 在指定命令集中按名查找命令。命令集省略时落到内置命令集 `builtinCommands`。
 */
export function findCommand(
  name: string,
  commands: readonly CommandDefinition[] = builtinCommands,
): CommandDefinition | undefined {
  return commands.find((command) => command.name === name);
}
