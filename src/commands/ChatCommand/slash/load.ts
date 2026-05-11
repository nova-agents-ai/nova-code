/**
 * /load 斜杠命令 —— 从 JSONL 恢复会话。
 *
 * 用法：
 *   /load <idOrAlias>
 *
 * 安全策略：若当前 session 非空，先通过 io.confirm 弹窗确认，防止误操作
 * 覆盖正在进行的对话。
 */

import { loadSession } from "../sessionStore.ts";
import type { SlashCommand } from "./types.ts";

export const loadCommand: SlashCommand = {
  name: "load",
  description: "从 ~/.nova-code/sessions/ 恢复一个会话",
  usage: "/load <idOrAlias>",
  async run(ctx) {
    const { session, io, args, configSource } = ctx;
    const target = args[0];
    if (target === undefined || target === "") {
      io.print("用法：/load <idOrAlias>\n");
      return { action: "continue" };
    }

    // 当前会话非空时需要二次确认，避免误覆盖在进行中的对话
    if (session.snapshot().length > 0) {
      const ok = await io.confirm("当前会话将被替换，继续？(y/n) ");
      if (!ok) {
        io.print("已取消 /load。\n");
        return { action: "continue" };
      }
    }

    try {
      const snapshot = await loadSession(target, configSource);
      session.restore(snapshot.meta, snapshot.messages);
      io.print(`已加载会话 ${snapshot.meta.sessionId}（${snapshot.messages.length} 条消息）。\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.print(`/load 失败：${message}\n`);
    }
    return { action: "continue" };
  },
};
