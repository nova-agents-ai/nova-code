/**
 * Agent Loop —— nova-code 的 LLM 对话主循环。
 *
 * 移植自 claude-code/src/query.ts 的 queryLoop()，剥离了所有非本质特性：
 * - 不做 compact / microcompact / context collapse（context 增长由 maxTurns 兜底）
 * - 不做 thinking / extended thinking 配置
 * - 不做 fallback model / 多层 retry（SDK 自带的 maxRetries 够用）
 * - 不做权限审批（工具默认全部允许）
 * - 不做 hooks / analytics
 *
 * 保留的本质：
 * 1. 调 messages.stream 拿到流式事件
 * 2. 转发文本增量给调用方（用于 stdout 流式打印）
 * 3. 拿完整 assistant message → 检查是否有 tool_use
 * 4. 有 tool_use：并行执行所有工具 → 把结果包成 user message → 加入历史 → 回到 1
 * 5. 无 tool_use（end_turn）：终止循环
 * 6. 超过 maxTurns 抛 MaxTurnsExceededError
 *
 * 公开 API 是 `runAgentLoop`，返回 AsyncGenerator<AgentEvent, NovaMessage>。
 * 调用方用 `for await` 消费事件，generator 返回值是最终 assistant message。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  RawMessageStreamEvent,
  Message as SdkMessage,
  MessageParam as SdkMessageParam,
  Tool as SdkTool,
} from "@anthropic-ai/sdk/resources/messages";
import type { ResolvedConfig } from "../config/config.ts";
import { createAnthropicClient } from "./client.ts";
import { AbortError, LLMApiError, MaxTurnsExceededError, ToolExecutionError } from "./errors.ts";
import { findTool } from "./tools.ts";
import {
  type AgentEvent,
  AgentStopReasonEnum,
  MessageRoleEnum,
  type NovaContentBlock,
  type NovaMessage,
  type Tool,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./types.ts";

/**
 * runAgentLoop 的入参。
 */
export interface AgentLoopParams {
  /** 已生效的配置（apiKey/model/maxTokens/maxTurns 等）。 */
  readonly config: ResolvedConfig;
  /** 用户初始 prompt（会被包成第一条 user message）。 */
  readonly userPrompt: string;
  /** 可选的 system prompt。缺省为 nova-code 的内置简短提示。 */
  readonly systemPrompt?: string;
  /** 可用工具集合。传空数组即关闭工具调用。 */
  readonly tools: readonly Tool[];
  /** 用户中断信号（Ctrl+C）。 */
  readonly signal?: AbortSignal;
  /**
   * 依赖注入：可选地传入自定义 SDK 客户端，方便测试时 mock。
   * 不传则按 config 创建真实客户端。
   */
  readonly client?: Anthropic;
}

/** 默认 system prompt：让模型知道自己在 nova-code 这个 CLI 里。 */
const DEFAULT_SYSTEM_PROMPT =
  "You are nova-code, a command-line coding assistant. " +
  "Use the provided tools to inspect the user's project before answering questions about code. " +
  "Be concise and direct.";

/**
 * 执行一次完整的 agent loop。
 *
 * AsyncGenerator 的设计：
 * - yield 出来的事件流给调用方做实时 UI 渲染
 * - return 值是最终的 assistant message（最后一轮的完整内容）
 * - 抛错代表无法挽救的失败（API 错误、abort、maxTurns 超限）
 */
export async function* runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentEvent, NovaMessage, void> {
  const { config, userPrompt, tools } = params;
  const systemPrompt = params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const signal = params.signal ?? new AbortController().signal;
  const client = params.client ?? createAnthropicClient(config);

  // 维护对话历史：第一条永远是用户初始 prompt
  const messages: NovaMessage[] = [
    {
      role: MessageRoleEnum.USER,
      content: userPrompt,
    },
  ];

  // 工具按 SDK 期望的 shape 转换一次（loop 内每次重建会浪费 CPU）
  const sdkTools: SdkTool[] = tools.map(toSdkTool);

  for (let turn = 1; turn <= config.maxTurns; turn += 1) {
    if (signal.aborted) {
      throw new AbortError();
    }

    yield { type: "turn_start", turn };

    const { assistantMessage, stopReason } = yield* streamOneTurn({
      client,
      config,
      systemPrompt,
      messages,
      sdkTools,
      signal,
    });

    messages.push(assistantMessage);

    yield {
      type: "turn_end",
      turn,
      message: assistantMessage,
      stopReason,
    };

    // 模型说完就结束，loop 终止
    if (stopReason !== AgentStopReasonEnum.TOOL_USE) {
      yield {
        type: "done",
        turns: turn,
        finalMessage: assistantMessage,
      };
      return assistantMessage;
    }

    // 提取本轮所有 tool_use 块，并行执行
    const toolUses = extractToolUses(assistantMessage);
    if (toolUses.length === 0) {
      // SDK 报告 tool_use 但我们没找到任何 tool_use 块——理论不可能，
      // 但作为防御性编程：当作 end_turn 处理避免死循环
      yield {
        type: "done",
        turns: turn,
        finalMessage: assistantMessage,
      };
      return assistantMessage;
    }

    const toolResults = yield* executeToolsAndYieldEvents({
      toolUses,
      tools,
      signal,
    });

    // 把所有 tool_result 打包成单条 user message，发回模型
    messages.push({
      role: MessageRoleEnum.USER,
      content: toolResults,
    });
  }

  // 走到这里说明耗尽了 maxTurns 还没看到 end_turn
  throw new MaxTurnsExceededError(config.maxTurns);
}

// ────────────────────────────────────────────────────────────────────────────
// 单轮：调一次 LLM，转发流式事件，拿到完整 assistant message
// ────────────────────────────────────────────────────────────────────────────

interface StreamOneTurnParams {
  readonly client: Anthropic;
  readonly config: ResolvedConfig;
  readonly systemPrompt: string;
  readonly messages: readonly NovaMessage[];
  readonly sdkTools: readonly SdkTool[];
  readonly signal: AbortSignal;
}

interface StreamOneTurnResult {
  readonly assistantMessage: NovaMessage;
  readonly stopReason: AgentStopReasonEnum;
}

async function* streamOneTurn(
  params: StreamOneTurnParams,
): AsyncGenerator<AgentEvent, StreamOneTurnResult, void> {
  const { client, config, systemPrompt, messages, sdkTools, signal } = params;

  // SDK 的 MessageStreamParams.tools 类型是 mutable ToolUnion[]，所以这里
  // 把 readonly 数组拷贝成 mutable 切片再传入。
  const requestParams = {
    model: config.model,
    max_tokens: config.maxTokens,
    system: systemPrompt,
    messages: messages.map(toSdkMessageParam),
    ...(sdkTools.length > 0 ? { tools: [...sdkTools] } : {}),
  };

  const stream = client.messages.stream(requestParams, { signal });

  // 流式消费：转发文本增量给调用方
  try {
    for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
      if (signal.aborted) {
        throw new AbortError();
      }
      const delta = extractTextDelta(event);
      if (delta !== undefined) {
        yield { type: "text_delta", delta };
      }
    }
  } catch (error) {
    throw normalizeSdkError(error);
  }

  // finalMessage 在流结束后立即可用（SDK 内部累积了所有事件）
  let final: SdkMessage;
  try {
    final = await stream.finalMessage();
  } catch (error) {
    throw normalizeSdkError(error);
  }

  return {
    assistantMessage: fromSdkMessage(final),
    stopReason: mapStopReason(final.stop_reason),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 工具执行：并行跑所有 tool_use，产出 tool_result 块
// ────────────────────────────────────────────────────────────────────────────

interface ExecuteToolsParams {
  readonly toolUses: readonly ToolUseBlock[];
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
}

async function* executeToolsAndYieldEvents(
  params: ExecuteToolsParams,
): AsyncGenerator<AgentEvent, ToolResultBlock[], void> {
  const { toolUses, tools, signal } = params;

  // 先发出 tool_call 事件（按声明顺序），再并行执行
  for (const use of toolUses) {
    yield {
      type: "tool_call",
      toolUseId: use.id,
      toolName: use.name,
      input: use.input,
    };
  }

  const settled = await Promise.allSettled(
    toolUses.map((use) => executeOneTool(use, tools, signal)),
  );

  const results: ToolResultBlock[] = [];
  for (const [index, outcome] of settled.entries()) {
    const use = toolUses[index];
    // toolUses 是 readonly 数组、长度与 settled 一致——这里不会越界，
    // 但 noUncheckedIndexedAccess 仍要求收窄
    if (use === undefined) continue;

    if (outcome.status === "fulfilled") {
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.value,
      };
      results.push(block);
      yield {
        type: "tool_result",
        toolUseId: use.id,
        toolName: use.name,
        content: outcome.value,
        isError: false,
      };
    } else {
      const errorMessage = describeToolError(outcome.reason, use.name);
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: use.id,
        content: errorMessage,
        is_error: true,
      };
      results.push(block);
      yield {
        type: "tool_result",
        toolUseId: use.id,
        toolName: use.name,
        content: errorMessage,
        isError: true,
      };
    }
  }
  return results;
}

async function executeOneTool(
  use: ToolUseBlock,
  tools: readonly Tool[],
  signal: AbortSignal,
): Promise<string> {
  const tool = findTool(use.name, tools);
  if (tool === undefined) {
    throw new ToolExecutionError(
      use.name,
      `Unknown tool '${use.name}'. Available tools: ${tools.map((t) => t.name).join(", ") || "(none)"}.`,
    );
  }
  return await tool.execute(use.input, { signal });
}

// ────────────────────────────────────────────────────────────────────────────
// 类型转换：nova ↔ SDK
// ────────────────────────────────────────────────────────────────────────────

function toSdkTool(tool: Tool): SdkTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: tool.input_schema.properties,
      ...(tool.input_schema.required !== undefined
        ? { required: [...tool.input_schema.required] }
        : {}),
    },
  };
}

function toSdkMessageParam(message: NovaMessage): SdkMessageParam {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map(toSdkContentBlock),
  };
}

function toSdkContentBlock(block: NovaContentBlock): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result": {
      const param: ContentBlockParam = {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error === true ? { is_error: true } : {}),
      };
      return param;
    }
  }
}

function fromSdkMessage(message: SdkMessage): NovaMessage {
  const blocks: NovaContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        // SDK 的 input 是 unknown；我们要求是 object，类型守卫一下
        input: isPlainObject(block.input) ? block.input : {},
      });
    }
    // 其它块类型（thinking / server_tool_use / ...）当前不传给上层，
    // 模型在 tool 循环里只关心 text 和 tool_use
  }
  return {
    role: MessageRoleEnum.ASSISTANT,
    content: blocks,
  };
}

function extractToolUses(message: NovaMessage): ToolUseBlock[] {
  if (typeof message.content === "string") return [];
  return message.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

function extractTextDelta(event: RawMessageStreamEvent): string | undefined {
  if (event.type !== "content_block_delta") return undefined;
  if (event.delta.type !== "text_delta") return undefined;
  return event.delta.text;
}

function mapStopReason(stopReason: SdkMessage["stop_reason"]): AgentStopReasonEnum {
  switch (stopReason) {
    case "end_turn":
      return AgentStopReasonEnum.END_TURN;
    case "tool_use":
      return AgentStopReasonEnum.TOOL_USE;
    case "max_tokens":
      return AgentStopReasonEnum.MAX_TOKENS;
    case "stop_sequence":
      return AgentStopReasonEnum.STOP_SEQUENCE;
    case "refusal":
      return AgentStopReasonEnum.REFUSAL;
    case "pause_turn":
      return AgentStopReasonEnum.PAUSE_TURN;
    case null:
    case undefined:
      // 罕见：SDK 没拿到 stop_reason。当作 end_turn 终止循环，避免死循环。
      return AgentStopReasonEnum.END_TURN;
    default:
      return AgentStopReasonEnum.END_TURN;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 错误处理
// ────────────────────────────────────────────────────────────────────────────

function normalizeSdkError(error: unknown): Error {
  if (error instanceof AbortError) return error;
  if (error instanceof APIUserAbortError) return new AbortError();
  if (error instanceof APIError) {
    return new LLMApiError(error.message, {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new LLMApiError(`LLM request failed: ${error.message}`, {
      cause: error,
    });
  }
  return new LLMApiError(`LLM request failed: ${String(error)}`);
}

function describeToolError(reason: unknown, fallbackToolName: string): string {
  if (reason instanceof ToolExecutionError) {
    return reason.message;
  }
  if (reason instanceof Error) {
    return `Tool '${fallbackToolName}' threw: ${reason.message}`;
  }
  return `Tool '${fallbackToolName}' threw: ${String(reason)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
