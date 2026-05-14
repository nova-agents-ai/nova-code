/**
 * compactConversation —— 主线压缩路径。
 *
 * 对齐 claude-code/src/services/compact/compact.ts:387 的 compactConversation。
 *
 * Forked-agent 风格的 prompt cache 共享（与 claude-code 同款）：
 *   调用方传入与主循环相同的 systemPrompt + sdkTools；compact 请求带上同样的
 *   system + tools 让上游 prompt cache key 匹配，命中命中后只有"最后追加的 compact
 *   user message"算 cache miss。同时设 tool_choice: {type:'none'} 强制模型走纯文本，
 *   不实际调用工具。
 *
 * 与 claude-code 的差异（仍保留的简化）：
 *   - 不挂 hooks（pre/post compact）；M10 才会引入 hook 系统
 *   - 不动态注入 file attachments（claude-code 在 summary 后会重新注入还活着的 file Read）；
 *     nova-code 暂保持 summary 自包含
 *
 * 流程（10 行可读完）：
 *   1. messages.length === 0 → 抛 ERROR_MESSAGE_NOT_ENOUGH_MESSAGES
 *   2. 估算 preCompactTokenCount（tokenCountWithEstimation 自动 walk-back-from-end）
 *   3. 把 getCompactPrompt(customInstructions) 包成 user message 追加到原对话末尾
 *   4. 调一次 messages.stream，**带与主循环同款的 system + tools + tool_choice:none**
 *      让 prompt cache 命中；max_tokens = MAX_OUTPUT_TOKENS_FOR_SUMMARY
 *   5. 流结束后从 finalMessage 取 text 块拼接出 rawSummaryText
 *   6. 文本为空 / 全空白 → 抛 ERROR_MESSAGE_INCOMPLETE_RESPONSE
 *   7. APIUserAbortError 原样上抛（调用方按 abort 处理）
 *   8. 用 getCompactUserSummaryMessage 把 summary 包成单条 user message
 *   9. 估算 postCompactTokenCount（即 summary message 自身的 char/4 估算）
 *  10. 返回 CompactionResult
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
import { logEvent } from "../analytics/index.ts";
import { MAX_OUTPUT_TOKENS_FOR_SUMMARY } from "./contextWindow.ts";
import { getCompactPrompt, getCompactUserSummaryMessage } from "./prompt.ts";
import {
  getTokenCountFromUsage,
  roughTokenCountEstimationForMessages,
  tokenCountWithEstimation,
} from "./tokens.ts";

/** 用于记录 compact 自身 LLM 调用的最小 sink；故意与 QueryEngine.LlmLogSink 鸭子兼容。 */
export interface CompactLogSink {
  readonly write: (payload: unknown) => void;
}

/** compactConversation 的入参。 */
export interface CompactConversationParams {
  /** 待压缩的对话历史。空数组会抛 ERROR_MESSAGE_NOT_ENOUGH_MESSAGES。 */
  readonly messages: readonly NovaMessage[];
  /** 已构造好的 Anthropic client（与 QueryEngine 共用一份，方便 mock）。 */
  readonly client: Anthropic;
  /** 模型名。M4 不切到更便宜的模型，原模型即用。 */
  readonly model: string;
  /** 触发来源：auto / manual。决定 summary 文本里是否追加 Continue 段落。 */
  readonly trigger: CompactTrigger;
  /** 自定义 summary 指令，对齐 /compact "<extra>" 用法。 */
  readonly customInstructions?: string;
  /** Ctrl+C / 上层 timeout 注入的中断信号。 */
  readonly signal?: AbortSignal;
  /** 可选的 LLM 调用日志 sink（与 QueryEngine 同型，可共用 chat-llm 文件）。 */
  readonly llmLogSink?: CompactLogSink;
  /**
   * Forked-agent cache 共享：与主循环相同的 system prompt。
   * 不传时不带 system，行为是无缓存命中的简单调用（仍能工作但首次必 cache miss）。
   */
  readonly systemPrompt?: string;
  /**
   * Forked-agent cache 共享：与主循环相同的工具定义。
   * 同时会自动加 tool_choice: {type:'none'} 强制模型走纯文本。
   */
  readonly sdkTools?: readonly SdkTool[];
}

/** compactConversation 的返回。 */
export interface CompactionResult {
  /** 用来替换原 messages 的单条 user message。 */
  readonly summaryMessage: NovaMessage;
  /** 估算的压缩前上下文 token 数（用于 UI / 日志展示）。 */
  readonly preCompactTokenCount: number;
  /** 压缩后上下文 token 数（即 summaryMessage 自身的估算）。 */
  readonly postCompactTokenCount: number;
  /** compact 这次 LLM 调用本身的 usage（供调用方更新自己的 anchor）。 */
  readonly compactionUsage: ApiUsage;
  /** 模型返回的原始 summary 文本，未 strip <analysis>。debug / e2e 用。 */
  readonly rawSummaryText: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 错误常量 —— 与 claude-code 同名，便于跨参考定位
// ────────────────────────────────────────────────────────────────────────────

export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = "There are no messages to compact yet.";

export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  "The model did not return a complete summary. Try again.";

/**
 * 主入口。约束：调用方必须自行处理 messages 替换 —— 本函数不接 ChatSession，
 * 只返回 summaryMessage 让上层重置内部 messages 数组。
 */
export async function compactConversation(
  params: CompactConversationParams,
): Promise<CompactionResult> {
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
  } = params;

  if (messages.length === 0) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
  }

  const preCompactTokenCount = tokenCountWithEstimation(messages);

  // 把压缩指令包成 user message 追加到对话尾部 —— 这样模型能看到完整对话再做 summary
  const summaryRequestMessage: NovaMessage = {
    role: MessageRoleEnum.USER,
    content: getCompactPrompt(customInstructions),
  };
  const apiMessages: SdkMessageParam[] = [...messages, summaryRequestMessage].map(
    toSdkMessageParam,
  );

  // Forked-agent 同款：传与主循环相同的 system + tools，让 prompt cache 命中；
  // tool_choice: { type: "none" } 强制模型纯文本响应（NO_TOOLS_PREAMBLE 是软约束，
  // tool_choice 是硬约束 —— 双层防御）。
  const requestParams = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    messages: apiMessages,
    ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
    ...(sdkTools !== undefined && sdkTools.length > 0
      ? { tools: [...sdkTools], tool_choice: { type: "none" as const } }
      : {}),
  };

  writeLog(llmLogSink, {
    kind: "compact_request",
    trigger,
    model,
    messageCount: messages.length,
    preCompactTokenCount,
  });
  logEvent("tengu_compact", {
    trigger,
    messageCount: messages.length,
    preCompactTokenCount,
  });

  const startedAt = Date.now();
  let final: SdkMessage;
  try {
    const stream = client.messages.stream(requestParams, signal === undefined ? {} : { signal });
    // 消费流；compact 不需要 text_delta（无 UI），但必须把流读完才能拿到 finalMessage
    for await (const _event of stream as AsyncIterable<RawMessageStreamEvent>) {
      if (signal?.aborted === true) {
        throw new APIUserAbortError();
      }
    }
    final = await stream.finalMessage();
  } catch (error) {
    writeLog(llmLogSink, {
      kind: "compact_error",
      trigger,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    logEvent("tengu_compact_error", {
      trigger,
      durationMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.name : "unknown",
    });
    // APIUserAbortError 原样透传，让上层按 abort 处理（不当作 INCOMPLETE_RESPONSE）
    throw error;
  }

  const rawSummaryText = extractAssistantText(final);
  if (rawSummaryText.trim() === "") {
    writeLog(llmLogSink, {
      kind: "compact_error",
      trigger,
      durationMs: Date.now() - startedAt,
      reason: "empty_summary",
    });
    logEvent("tengu_compact_error", {
      trigger,
      durationMs: Date.now() - startedAt,
      reason: "empty_summary",
    });
    throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
  }

  const compactionUsage: ApiUsage = {
    input_tokens: final.usage.input_tokens,
    cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: final.usage.cache_read_input_tokens ?? null,
    output_tokens: final.usage.output_tokens,
  };

  // 主路径不保留尾部 → recentMessagesPreserved = false
  const summaryUserText = getCompactUserSummaryMessage(
    rawSummaryText,
    /* suppressFollowUpQuestions */ trigger === "auto",
    /* recentMessagesPreserved */ false,
  );
  const summaryMessage: NovaMessage = {
    role: MessageRoleEnum.USER,
    content: summaryUserText,
  };

  const postCompactTokenCount = roughTokenCountEstimationForMessages([summaryMessage]);

  writeLog(llmLogSink, {
    kind: "compact_response",
    trigger,
    durationMs: Date.now() - startedAt,
    usage: compactionUsage,
    usageTotal: getTokenCountFromUsage(compactionUsage),
    preCompactTokenCount,
    postCompactTokenCount,
    rawSummaryLength: rawSummaryText.length,
  });
  logEvent("tengu_compact_done", {
    trigger,
    durationMs: Date.now() - startedAt,
    preCompactTokenCount,
    postCompactTokenCount,
    compactionTokens: getTokenCountFromUsage(compactionUsage),
  });

  return {
    summaryMessage,
    preCompactTokenCount,
    postCompactTokenCount,
    compactionUsage,
    rawSummaryText,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

function toSdkMessageParam(message: NovaMessage): SdkMessageParam {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text };
            if (block.type === "tool_use") {
              return {
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.input,
              };
            }
            // tool_result
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
    // log sink 失败不应影响 compact 主流程
  }
}
