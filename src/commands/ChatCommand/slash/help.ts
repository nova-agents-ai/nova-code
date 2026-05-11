/**
 * /help 斜杠命令 —— 列出所有可用的斜杠命令及用法。
 *
 * 为避免循环 import：help.ts 不直接引用 registry.ts，而是由 registry 在
 * 注册时把 registry 数组通过闭包传进来。实现上用工厂函数返回 SlashCommand。
 */

import type { SlashCommand } from "./types.ts";

/**
 * 构造 /help：给定所有斜杠命令（不含 help 自身也行），返回可用的命令。
 *
 * 设计取舍：不在 registry 里硬写循环依赖，改由工厂注入，既避免 import 环
 * 又让 /help 的展示顺序由 registry 完全掌控。
 */
export function makeHelpCommand(allCommands: () => readonly SlashCommand[]): SlashCommand {
  return {
    name: "help",
    description: "列出所有斜杠命令",
    usage: "/help",
    async run(ctx) {
      const commands = allCommands();
      const lines: string[] = ["可用斜杠命令："];
      for (const cmd of commands) {
        lines.push(`  /${cmd.name}  ${cmd.description}`);
      }
      lines.push("");
      ctx.io.print(`${lines.join("\n")}\n`);
      return { action: "continue" };
    },
  };
}
