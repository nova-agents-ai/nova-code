/**
 * 命令定义相关的公共类型。
 *
 * 独立成文件是为了避免命令实现互相 import 时绕过 src/commands.ts 聚合层形成环依赖。
 */

export type CommandHandler = (args: readonly string[]) => Promise<number> | number;

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly run: CommandHandler;
}
