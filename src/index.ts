/**
 * 库入口：对外导出 CLI 的可编程接口，方便其他模块或测试直接调用。
 */

export type { RunCliOptions } from "./cli.ts";
export { runCli } from "./cli.ts";
export type { CommandDefinition, CommandHandler } from "./commands.ts";
export { builtinCommands, findCommand } from "./commands.ts";
