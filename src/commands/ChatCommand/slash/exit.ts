/**
 * /exit 斜杠命令 —— 优雅退出 REPL。
 *
 * 与 Ctrl+C 双按路径的区别：
 * - /exit 明确是用户意图正常退出，退出码 0
 * - Ctrl+C 双按代表中断，退出码 130（在 runChatRepl 侧处理）
 */

import type { SlashCommand } from "./types.ts";

export const exitCommand: SlashCommand = {
  name: "exit",
  description: "退出 chat REPL",
  usage: "/exit",
  async run(_ctx) {
    return { action: "exit", exitCode: 0 };
  },
};
