/**
 * Token 计数 —— claude-code 同款 walk-back-from-end 算法。
 *
 * 对齐 claude-code/src/utils/tokens.ts:226 (tokenCountWithEstimation)：
 *   tokenCountWithEstimation = "messages 数组中最后一条带 usage 的 assistant"
 *                              的 usage 总和 + 该消息之后所有新 messages 的 chars/4 估算
 *
 * 与早期 nova-code 版本的差异（已对齐）：
 *   - 不再用独立 tracking state 跟踪锚点；usage 直接内嵌到 NovaMessage 上
 *     （types/message.ts:NovaMessage.usage?: ApiUsage）
 *   - QueryEngine.streamOneTurn 完成后把 final.usage 挂到 assistant message
 *
 * roughTokenCountEstimationForMessages 估算公式：sum(content 字符数) / 4 向上取整。
 * 对中英混合文本是粗估；M4 仅用于阈值触发判定，偏保守即可。
 */

import type { ApiUsage, NovaMessage } from "../../types/message.ts";

// 重新导出 ApiUsage —— M4 早期把它放在本文件，外部模块（如 compact.ts）已经从这里 import。
// 现在 ApiUsage 真正的位置在 types/message.ts；保留 re-export 避免破坏既有 import 链。
export type { ApiUsage };

/**
 * 把 SDK 的 usage 折算成"该次请求的总 token 占用"。
 *
 * 对齐 claude-code/src/utils/tokens.ts:46（getTokenCountFromUsage）：
 *   input + cache_creation + cache_read + output
 */
export function getTokenCountFromUsage(usage: ApiUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

/**
 * 粗估一组 messages 的 token 数：sum(字符数) / 4 向上取整。
 *
 * 字符数统计规则：
 * - 字符串 content：直接取 length
 * - text block：取 text.length
 * - tool_use block：JSON.stringify(input).length + name.length
 * - tool_result block：content.length
 */
export function roughTokenCountEstimationForMessages(messages: readonly NovaMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += charsForContent(msg.content);
  }
  return Math.ceil(totalChars / 4);
}

/**
 * 当前对话的"上下文 token 数"估算 —— autoCompact 阈值判定的规范入口。
 *
 * 算法（对齐 claude-code/src/utils/tokens.ts:226）：
 *   1. 从末尾向前扫，找到最近一条带 usage 的 assistant message（锚点）
 *   2. 取 usage.total（input + cache + output）+ 锚点之后 messages 的 chars/4 估算
 *   3. 没有任何带 usage 的消息 → 全量走 chars/4 估算（首轮 / compact 后回退路径）
 */
export function tokenCountWithEstimation(messages: readonly NovaMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.usage !== undefined) {
      return (
        getTokenCountFromUsage(msg.usage) +
        roughTokenCountEstimationForMessages(messages.slice(i + 1))
      );
    }
  }
  return roughTokenCountEstimationForMessages(messages);
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

function charsForContent(content: NovaMessage["content"]): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "tool_use") {
      // JSON.stringify 不会抛（input 是 Record<string, unknown>，由 SDK 解析过）
      chars += JSON.stringify(block.input).length + block.name.length;
    } else if (block.type === "tool_result") {
      chars += block.content.length;
    }
  }
  return chars;
}
