/**
 * 自动 compact 触发器 + circuit breaker。
 *
 * 对齐 claude-code/src/services/compact/autoCompact.ts。
 *
 * 核心定理：
 *   shouldAutoCompact = enabled && tokenCountWithEstimation(messages) >= threshold
 *
 * Circuit breaker：连续 3 次自动 compact 失败即停用本会话；防止
 * "不可恢复的超长上下文"无限烧 API。对齐 claude-code 的 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES。
 *
 * Tracking state 设计为可变 struct：QueryEngine 的主循环每轮读写它的字段，
 * 不需要返回新对象。这与 claude-code 的 AutoCompactTrackingState 形态一致。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type { Tool as SdkTool } from "@anthropic-ai/sdk/resources/messages";
import type { CompactTrigger, NovaMessage } from "../../types/message.ts";
import { logEvent } from "../analytics/index.ts";
import { type CompactionResult, type CompactLogSink, compactConversation } from "./compact.ts";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  WARNING_THRESHOLD_BUFFER_TOKENS,
} from "./contextWindow.ts";
import { tokenCountWithEstimation } from "./tokens.ts";

/** 连续失败阈值。对齐 claude-code (MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3)。 */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

/**
 * 自动 compact 的可变状态。每个 chat / ask 会话持有一个实例，跨多 turn 复用。
 *
 * 字段：
 * - compacted              ：本会话是否已经发生过 ≥1 次自动 compact
 * - turnCounter            ：自上次 compact 以来过了多少轮（compact 后清零）
 * - consecutiveFailures    ：连续失败次数；circuit breaker 用
 *
 * 历史包袱说明：早期版本曾有独立字段维护 token 锚点；
 * M4 末把 usage 内嵌到 NovaMessage 后，tokenCountWithEstimation 直接走
 * walk-back-from-end 算法（claude-code 同款），不再需要外部锚点。
 */
export interface AutoCompactTrackingState {
  compacted: boolean;
  turnCounter: number;
  consecutiveFailures: number;
}

/** 工厂：返回一个全零初始状态。 */
export function createAutoCompactTrackingState(): AutoCompactTrackingState {
  return {
    compacted: false,
    turnCounter: 0,
    consecutiveFailures: 0,
  };
}

/**
 * 给定当前 token 用量与模型，返回各种阈值状态。M4 暂时只在 autoCompact 内
 * 使用 isAboveAutoCompactThreshold；其它字段供未来 UI 警示条扩展。
 *
 * 对齐 claude-code/src/services/compact/autoCompact.ts:93（calculateTokenWarningState）。
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  readonly percentLeft: number;
  readonly isAboveAutoCompactThreshold: boolean;
  readonly isAboveWarningThreshold: boolean;
} {
  const autoCompactThreshold = getAutoCompactThreshold(model);
  const warningThreshold = autoCompactThreshold - WARNING_THRESHOLD_BUFFER_TOKENS;

  const percentLeft = Math.max(
    0,
    Math.round(((autoCompactThreshold - tokenUsage) / autoCompactThreshold) * 100),
  );

  return {
    percentLeft,
    isAboveAutoCompactThreshold: tokenUsage >= autoCompactThreshold,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
  };
}

/**
 * 判断当前对话是否需要自动 compact。
 *
 * 不使用 tracking.consecutiveFailures —— circuit breaker 在 autoCompactIfNeeded 内
 * 检查，shouldAutoCompact 仅做"阈值判定"这一件事，方便单测。
 */
export function shouldAutoCompact(params: {
  readonly messages: readonly NovaMessage[];
  readonly model: string;
  readonly enabled: boolean;
}): boolean {
  if (!params.enabled) return false;
  if (params.messages.length === 0) return false;
  const tokenCount = tokenCountWithEstimation(params.messages);
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, params.model);
  return isAboveAutoCompactThreshold;
}

/** autoCompactIfNeeded 的入参。 */
export interface AutoCompactIfNeededParams {
  readonly messages: readonly NovaMessage[];
  readonly client: Anthropic;
  readonly model: string;
  readonly tracking: AutoCompactTrackingState;
  readonly enabled: boolean;
  readonly signal?: AbortSignal;
  readonly llmLogSink?: CompactLogSink;
  /** Forked-agent cache 共享：与主循环相同的 system prompt 让 prompt cache 命中。 */
  readonly systemPrompt?: string;
  /** Forked-agent cache 共享：与主循环相同的工具定义。 */
  readonly sdkTools?: readonly SdkTool[];
}

/** autoCompactIfNeeded 的返回。 */
export interface AutoCompactOutcome {
  readonly wasCompacted: boolean;
  readonly preCompactTokenCount?: number;
  readonly postCompactTokenCount?: number;
  /** compact 成功时的 summary message；调用方应替换 messages 数组。 */
  readonly summaryMessage?: NovaMessage;
  /** compact 失败时的错误信息（不抛错，让主循环继续；下一轮可能 prompt_too_long 拒绝） */
  readonly error?: string;
  /** 完整 CompactionResult，方便调用方需要原始数据时取用。 */
  readonly compactionResult?: CompactionResult;
}

/**
 * 主入口：在 QueryEngine 每轮 streamOneTurn 之前调一次。
 *
 * 设计选择 —— 失败不抛：autoCompact 失败应该静默重试或降级；如果上抛，整个
 * agent loop 就崩了。手动 /compact 走的是 ChatSession.compact()，那里允许上抛。
 */
export async function autoCompactIfNeeded(
  params: AutoCompactIfNeededParams,
): Promise<AutoCompactOutcome> {
  const { messages, client, model, tracking, enabled, signal, llmLogSink } = params;

  if (!enabled) return { wasCompacted: false };
  // Circuit breaker
  if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    logEvent("tengu_autocompact_circuit_breaker_skip", {
      consecutiveFailures: tracking.consecutiveFailures,
    });
    return { wasCompacted: false };
  }
  if (!shouldAutoCompact({ messages, model, enabled })) {
    return { wasCompacted: false };
  }

  const trigger: CompactTrigger = "auto";
  try {
    const result = await compactConversation({
      messages,
      client,
      model,
      trigger,
      signal,
      ...(llmLogSink ? { llmLogSink } : {}),
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.sdkTools !== undefined ? { sdkTools: params.sdkTools } : {}),
    });

    // 成功：重置 tracking
    tracking.compacted = true;
    tracking.turnCounter = 0;
    tracking.consecutiveFailures = 0;

    return {
      wasCompacted: true,
      preCompactTokenCount: result.preCompactTokenCount,
      postCompactTokenCount: result.postCompactTokenCount,
      summaryMessage: result.summaryMessage,
      compactionResult: result,
    };
  } catch (error) {
    // 用户 abort 直接传播：让上层走 abort 处理
    if (error instanceof APIUserAbortError) {
      throw error;
    }
    tracking.consecutiveFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    logEvent("tengu_autocompact_failure", {
      consecutiveFailures: tracking.consecutiveFailures,
      reason: error instanceof Error ? error.name : "unknown",
    });
    if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logEvent("tengu_autocompact_circuit_breaker_tripped", {
        consecutiveFailures: tracking.consecutiveFailures,
      });
    }
    return { wasCompacted: false, error: message };
  }
}

/** 便利 helper：报"还剩多少 token 才触发"，供 UI / debug 展示。 */
export function getRemainingTokensUntilAutoCompact(
  messages: readonly NovaMessage[],
  model: string,
): number {
  const tokenCount = tokenCountWithEstimation(messages);
  const threshold = getAutoCompactThreshold(model);
  return Math.max(0, threshold - tokenCount);
}

/** 便利 helper：报有效 window 减 buffer 后的剩余空间。 */
export function getEffectiveRemainingTokens(
  messages: readonly NovaMessage[],
  model: string,
): number {
  const tokenCount = tokenCountWithEstimation(messages);
  return Math.max(0, getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS - tokenCount);
}
