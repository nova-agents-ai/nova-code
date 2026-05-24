/**
 * partialCompactConversation —— 保留尾部 N 轮原文的回退方案。
 *
 * 触发场景（roadmap §M4 失败信号）：主线 compactConversation 后模型大量遗忘 →
 * 配置 `compactStrategy = "partial"` 切换到本路径，仅压缩"最近 N 轮之前"的部分，
 * 最近 N 轮 user→assistant 链路保持原文不变。
 *
 * 对齐 claude-code/src/services/compact/compact.ts:772 的 partialCompactConversation
 * + claude-code/src/services/compact/grouping.ts 的 groupMessagesByApiRound。nova-code
 * 简化为按"用户文本输入"划分轮次（NovaMessage 没有稳定 id）。
 *
 * 算法（5 步）：
 *   1. 扫描 messages，记录所有"用户原始输入"的下标作为 roundBoundaries[]
 *      —— 判定标准：role=USER 且 content 是 string（非 tool_result 数组）
 *   2. boundaries.length <= keepRecent → 抛 ERROR_MESSAGE_NOT_ENOUGH_MESSAGES
 *   3. splitIndex = boundaries[boundaries.length - keepRecent]
 *      prefix = messages[0..splitIndex)，tail = messages[splitIndex..]
 *   4. 用 PARTIAL_COMPACT_PROMPT 让模型只 summarize prefix
 *   5. 返回 [summaryMessage, ...tail] 给上层替换
 */

import type Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  Message as SdkMessage,
  MessageParam as SdkMessageParam,
  Tool as SdkTool,
} from "@anthropic-ai/sdk/resources/messages";
import {
  type ApiUsage,
  type CompactTrigger,
  MessageRoleEnum,
  type NovaMessage,
} from "../../types/message.ts";
import {
  type CompactionResult,
  type CompactLogSink,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
} from "./compact.ts";
import { MAX_OUTPUT_TOKENS_FOR_SUMMARY } from "./contextWindow.ts";
import { getCompactUserSummaryMessage, getPartialCompactPrompt } from "./prompt.ts";
import { roughTokenCountEstimationForMessages, tokenCountWithEstimation } from "./tokens.ts";

/** 默认保留尾部轮数。对齐 claude-code/src/services/compact/timeBasedMCConfig.ts:33 (keepRecent=5). */
export const DEFAULT_KEEP_RECENT_ROUNDS = 5;

export interface PartialCompactParams {
  readonly messages: readonly NovaMessage[];
  readonly client: Anthropic;
  readonly model: string;
  readonly trigger: CompactTrigger;
  readonly customInstructions?: string;
  readonly signal?: AbortSignal;
  readonly llmLogSink?: CompactLogSink;
  /** Forked-agent cache 共享：与主循环相同的 system prompt。 */
  readonly systemPrompt?: string;
  /** Forked-agent cache 共享：与主循环相同的工具定义。 */
  readonly sdkTools?: readonly SdkTool[];
  /** 保留尾部多少轮"用户原始输入"。缺省 5。 */
  readonly keepRecent?: number;
}

/**
 * partialCompact 的返回。在 CompactionResult 之上多 keptMessages（保留下来的尾部）
 * 与 splitIndex（被压缩的前缀长度）。
 *
 * 调用方应组装最终 messages = [summaryMessage, ...keptMessages] 作为新对话历史。
 */
export interface PartialCompactionResult extends CompactionResult {
  readonly keptMessages: readonly NovaMessage[];
  readonly splitIndex: number;
}

export async function partialCompactConversation(
  params: PartialCompactParams,
): Promise<PartialCompactionResult> {
  const {
    messages,
    client,
    model,
    trigger,
    customInstructions,
    signal,
    llmLogSink,
    systemPrompt,
    sdkTools,
    keepRecent = DEFAULT_KEEP_RECENT_ROUNDS,
  } = params;

  if (keepRecent < 1) {
    throw new Error("keepRecent must be ≥ 1");
  }
  if (messages.length === 0) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
  }

  const boundaries = findRoundBoundaries(messages);
  if (boundaries.length <= keepRecent) {
    // 不够 keepRecent + 1 轮 → 没有需要压缩的前缀
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
  }

  const splitIndex = boundaries[boundaries.length - keepRecent];
  if (splitIndex === undefined || splitIndex <= 0) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
  }

  const prefix = messages.slice(0, splitIndex);
  const keptMessages = messages.slice(splitIndex);
  const preCompactTokenCount = tokenCountWithEstimation(messages);

  // 把压缩指令包成 user message 追加到 prefix 末尾
  const summaryRequest: NovaMessage = {
    role: MessageRoleEnum.USER,
    content: getPartialCompactPrompt(customInstructions),
  };
  const apiMessages: SdkMessageParam[] = [...prefix, summaryRequest].map(toSdkMessageParam);

  writeLog(llmLogSink, {
    kind: "partial_compact_request",
    trigger,
    model,
    prefixCount: prefix.length,
    keptCount: keptMessages.length,
    preCompactTokenCount,
  });

  // Forked-agent 同款：与主循环相同的 system + tools 让 prompt cache 命中
  const requestParams = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    messages: apiMessages,
    ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
    ...(sdkTools !== undefined && sdkTools.length > 0
      ? { tools: [...sdkTools], tool_choice: { type: "none" as const } }
      : {}),
  };

  const startedAt = Date.now();
  let final: SdkMessage;
  try {
    const stream = client.messages.stream(requestParams, signal === undefined ? {} : { signal });
    for await (const _event of stream as AsyncIterable<RawMessageStreamEvent>) {
      if (signal?.aborted === true) {
        throw new APIUserAbortError();
      }
    }
    final = await stream.finalMessage();
  } catch (error) {
    writeLog(llmLogSink, {
      kind: "partial_compact_error",
      trigger,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    throw error;
  }

  const rawSummaryText = extractAssistantText(final);
  if (rawSummaryText.trim() === "") {
    throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
  }

  const compactionUsage: ApiUsage = {
    input_tokens: final.usage.input_tokens,
    cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: final.usage.cache_read_input_tokens ?? null,
    output_tokens: final.usage.output_tokens,
  };

  const summaryUserText = getCompactUserSummaryMessage(
    rawSummaryText,
    /* suppressFollowUpQuestions */ trigger === "auto",
    /* recentMessagesPreserved */ true,
  );
  const summaryMessage: NovaMessage = {
    role: MessageRoleEnum.USER,
    content: summaryUserText,
  };

  const postCompactTokenCount = roughTokenCountEstimationForMessages([
    summaryMessage,
    ...keptMessages,
  ]);

  writeLog(llmLogSink, {
    kind: "partial_compact_response",
    trigger,
    durationMs: Date.now() - startedAt,
    preCompactTokenCount,
    postCompactTokenCount,
    keptCount: keptMessages.length,
  });

  return {
    summaryMessage,
    preCompactTokenCount,
    postCompactTokenCount,
    compactionUsage,
    rawSummaryText,
    keptMessages,
    splitIndex,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

/**
 * 扫描 messages，找到所有"用户原始输入"位置作为轮次边界。
 *
 * 判定：role=USER 且 content 是 string（不是 tool_result 数组）。
 * tool_result wrapper 的 user message 是 assistant 上一条的延续，不算新一轮。
 */
function findRoundBoundaries(messages: readonly NovaMessage[]): readonly number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.role === MessageRoleEnum.USER && typeof msg.content === "string") {
      boundaries.push(i);
    }
  }
  return boundaries;
}

function toSdkMessageParam(message: NovaMessage): SdkMessageParam {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text };
            if (block.type === "image") {
              // Same rationale as compact.ts: don't resend base64 to the
              // partial-compact LLM call.
              return {
                type: "text" as const,
                text: `[image attachment elided for compact: ${block.source.media_type}, ${block.source.data.length} base64 chars]`,
              };
            }
            if (block.type === "tool_use") {
              return {
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.input,
              };
            }
            return {
              type: "tool_result" as const,
              tool_use_id: block.tool_use_id,
              content: block.content,
              ...(block.is_error === true ? { is_error: true } : {}),
            };
          }),
  };
}

function extractAssistantText(message: SdkMessage): string {
  let out = "";
  for (const block of message.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

function writeLog(sink: CompactLogSink | undefined, payload: unknown): void {
  if (sink === undefined) return;
  try {
    sink.write(payload);
  } catch {
    // ignore
  }
}
