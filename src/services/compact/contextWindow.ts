/**
 * 模型上下文窗口大小与各种自动 compact 阈值常量。
 *
 * 对齐 claude-code/src/utils/context.ts + claude-code/src/services/compact/autoCompact.ts。
 *
 * 设计取舍：
 * - claude-code 的 getContextWindowForModel 还会查 SDK Beta 表（含 1M context beta），
 *   nova-code M4 暂不接 beta 表，所有模型按 200K 或显式查表返回。
 * - 多个 buffer 常量（AUTOCOMPACT / WARNING / ERROR / MANUAL）的语义与 claude-code 一一对应，
 *   即使 M4 只用到 AUTOCOMPACT 与 MAX_OUTPUT_TOKENS_FOR_SUMMARY，其它常量也照样导出，
 *   方便 Phase 2 扩展时不需要再改这一层。
 */

/**
 * 默认上下文窗口大小（token）。Claude 4 系列主流模型均为 200K。
 * 对齐 claude-code/src/utils/context.ts:9（MODEL_CONTEXT_WINDOW_DEFAULT）。
 */
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;

/**
 * 为 compact 自身的 summary 输出预留的 token 数。
 * 基于 claude-code 的统计 p99.99 ≈ 17,387，取 20K 作上限。
 * 对齐 claude-code/src/services/compact/autoCompact.ts:30（MAX_OUTPUT_TOKENS_FOR_SUMMARY）。
 */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/**
 * 自动触发 compact 的安全余量。effectiveWindow - this = 阈值。
 * 对齐 claude-code/src/services/compact/autoCompact.ts:62（AUTOCOMPACT_BUFFER_TOKENS）。
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * 警告阈值的余量（autoCompact 阈值之下再留 20K 给警告）。
 * 与 claude-code 同名常量对齐；M4 暂不实现警告 UI，但导出供后续扩展使用。
 */
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;

/**
 * 错误阈值的余量。
 * M4 暂不实现错误条 UI，但导出对齐 claude-code 常量。
 */
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;

/**
 * 手动 /compact 触发时的最低余量；保留 3K 给最终 summary 文本。
 * M4 不在 /compact 路径里检查（claude-code 也只在 reactive 里用），但导出供后续扩展。
 */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/**
 * 给定模型名，返回该模型的上下文窗口大小（token）。
 *
 * 简化版查表：默认 200K；未来要支持其它 provider 时按 prefix 区分即可。
 */
export function getContextWindowForModel(model: string): number {
  // claude-3-5-sonnet-... / claude-3-5-haiku-... / claude-3-opus-... 都是 200K
  // claude-4-* 系列同样 200K（claude-sonnet-4-5 / claude-opus-4-7 / claude-haiku-4-5）
  // 历史 claude-2 / claude-instant 是 100K，但用户不太可能再用，落到 default 也只是窗口偏宽
  if (model.includes("claude")) {
    return MODEL_CONTEXT_WINDOW_DEFAULT;
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

/**
 * "有效"上下文窗口 = 总窗口 - 给 summary 输出预留的 token。
 * 触发阈值进一步减去 AUTOCOMPACT_BUFFER_TOKENS。
 *
 * 对齐 claude-code/src/services/compact/autoCompact.ts:33（getEffectiveContextWindowSize）。
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedForSummary = Math.min(
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    // claude-code 还会查 getMaxOutputTokensForModel；nova-code 简化为固定上限
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return getContextWindowForModel(model) - reservedForSummary;
}

/**
 * 自动 compact 的触发阈值。当估算的当前上下文 token 数 ≥ 此值即触发。
 *
 * 对齐 claude-code/src/services/compact/autoCompact.ts:72（getAutoCompactThreshold）。
 */
export function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS;
}
