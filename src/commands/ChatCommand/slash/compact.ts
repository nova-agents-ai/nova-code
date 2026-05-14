/**
 * /compact 斜杠命令 —— 强制压缩当前对话历史。
 *
 * 与 sendTurn 路径上的自动 compact 用同一份 compactConversation；区别：
 *   - 无视阈值（用户主动触发）
 *   - trigger = "manual"（summary 文本不含 "Continue the conversation" 段落）
 *   - 支持自定义指令：`/compact focus on test files` → 整个 args 拼成 customInstructions
 *
 * 对齐 claude-code/src/commands/compact/compact.ts:108-119 的语义：
 * 直接重置 ChatSession.messages 为单条 summary user message。
 */

import type { SlashCommand } from "./types.ts";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "强制压缩对话历史为一段 summary（claude-code 同款语义）",
  usage:
    "/compact                       压缩并重置 messages\n" +
    "/compact <自定义指令>          额外提示模型在 summary 中关注什么",
  async run(ctx) {
    const { io, args, session, chatRuntime } = ctx;

    if (chatRuntime === undefined) {
      io.print("无法执行 /compact：chat 运行时上下文未注入。\n");
      return { action: "continue" };
    }

    const customInstructions = args.join(" ").trim();

    try {
      const outcome = await session.compact(
        {
          config: chatRuntime.config,
          signal: chatRuntime.signal,
          ...(chatRuntime.systemPrompt !== undefined
            ? { systemPrompt: chatRuntime.systemPrompt }
            : {}),
          ...(chatRuntime.projectInstructions !== undefined
            ? { projectInstructions: chatRuntime.projectInstructions }
            : {}),
          ...(chatRuntime.tools !== undefined ? { tools: chatRuntime.tools } : {}),
          ...(chatRuntime.llmLogSink !== undefined ? { llmLogSink: chatRuntime.llmLogSink } : {}),
        },
        customInstructions === "" ? undefined : customInstructions,
      );
      chatRuntime.costTracker?.recordUsage(chatRuntime.config.model, outcome.compactionUsage);
      io.print(
        `已压缩 ${outcome.compactedMessages} 条消息 → 1 条 summary` +
          ` (≈ ${outcome.preCompactTokenCount} → ${outcome.postCompactTokenCount} tokens)\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.print(`/compact 失败：${message}\n`);
    }
    return { action: "continue" };
  },
};
