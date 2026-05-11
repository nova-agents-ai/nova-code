/**
 * /clear 斜杠命令 —— 清空当前会话历史。
 *
 * 不触 session.meta（sessionId/model/createdAt 都保留），仅把 messages 置空。
 * 这样 /clear 之后紧接一次 /save 依然写到同一个 sessionId.jsonl，
 * 对齐用户对"重开一段对话"的直觉。
 */

import type { SlashCommand } from "./types.ts";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "清空当前对话历史（sessionId 保留）",
  usage: "/clear",
  async run(ctx) {
    ctx.session.clear();
    ctx.io.print("已清空当前会话历史。\n");
    return { action: "continue" };
  },
};
