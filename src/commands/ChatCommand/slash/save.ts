/**
 * /save 斜杠命令 —— 把当前会话覆盖写到 JSONL。
 *
 * 用法：
 *   /save             → 写到 sessions/<sessionId>.jsonl
 *   /save <alias>     → 额外再写一份 sessions/<alias>.jsonl（文件副本）
 *
 * 空会话也可以保存（只有 meta 行）；这样用户可以在新开 session 后立刻
 * /save 固化 sessionId，不必等到回合结束。
 */

import { saveSession } from "../sessionStore.ts";
import type { SlashCommand } from "./types.ts";

export const saveCommand: SlashCommand = {
  name: "save",
  description: "把当前会话保存到 ~/.nova-code/sessions/",
  usage:
    "/save [alias]\n  不带参数：覆盖写 <sessionId>.jsonl\n  带 alias：额外再写一份 <alias>.jsonl",
  async run(ctx) {
    const { session, io, args, configSource } = ctx;
    const snapshot = { meta: session.meta, messages: session.snapshot() };

    try {
      // 1) 始终按 sessionId 写一份，作为主记录
      const mainPath = await saveSession(session.meta.sessionId, snapshot, configSource);
      io.print(`已保存到 ${mainPath}\n`);

      // 2) 若还指定了 alias，再写一份副本文件
      const alias = args[0];
      if (alias !== undefined && alias !== "") {
        const aliasPath = await saveSession(alias, snapshot, configSource);
        io.print(`别名副本：${aliasPath}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.print(`/save 失败：${message}\n`);
    }
    return { action: "continue" };
  },
};
