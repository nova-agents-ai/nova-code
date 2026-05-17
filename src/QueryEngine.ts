/**
 * Agent Loop —— nova-code 的 LLM 对话主循环。
 *
 * M1.5 起从 src/llm/query.ts 搬到顶层 src/QueryEngine.ts，结构对齐
 * claude-code/src/QueryEngine.ts（文件名对齐；入口函数仍是 runAgentLoop，
 * 不重命名 —— claude-code 的 query() 函数签名是 M12+ 的形状，纳什当前无法对齐）。
 *
 * 移植自 claude-code/src/query.ts 的 queryLoop()，剥离了所有非本质特性：
 * - 不做 compact / microcompact / context collapse（context 增长由 maxTurns 兜底）
 * - 不做 thinking / extended thinking 配置
 * - 不做 fallback model / 多层 retry（SDK 自带的 maxRetries 够用；
 *   M1.5 新增 services/api/withRetry.ts 薄层在 QueryEngine 之外按需包装）
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
import type { ResolvedConfig } from "./config/config.ts";
import { AbortError, MaxTurnsExceededError, ToolExecutionError } from "./errors/index.ts";
import { logEvent } from "./services/analytics/index.ts";
import { createAnthropicClient } from "./services/api/client.ts";
import { LLMApiError } from "./services/api/errors.ts";
import {
  type AutoCompactTrackingState,
  autoCompactIfNeeded,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  shouldAutoCompact,
} from "./services/compact/autoCompact.ts";
import { tokenCountWithEstimation } from "./services/compact/tokens.ts";
import { executeHookBatch } from "./services/hooks/hookRunner.ts";
import {
  type HookBatchResult,
  HookEventName,
  type HookExecutionRecord,
  type HooksConfig,
} from "./services/hooks/types.ts";
import { BASH_TOOL_NAME } from "./services/permissions/bashRuleMatcher.ts";
import { extractBashCommand } from "./services/permissions/dangerousPatterns.ts";
import { extractFilePath, isFileWriteToolName } from "./services/permissions/fileRuleMatcher.ts";
import {
  decisionFromUserChoice,
  type PermissionProvider,
} from "./services/permissions/PermissionProvider.ts";
import { evaluatePermission } from "./services/permissions/permissionEngine.ts";
import type { PermissionStore } from "./services/permissions/permissionStore.ts";
import type { Tool } from "./Tool.ts";
import { TODO_WRITE_TOOL_NAME } from "./tools/TodoWriteTool/constants.ts";
import { TODO_WRITE_SYSTEM_PROMPT } from "./tools/TodoWriteTool/prompt.ts";
import { findTool } from "./tools.ts";
import {
  type AgentEvent,
  AgentStopReasonEnum,
  MessageRoleEnum,
  type NovaContentBlock,
  type NovaMessage,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./types/message.ts";
import type { PermissionMode, PermissionRule } from "./types/permissions.ts";

/**
 * 用于记录原始 LLM 请求/响应的最小 sink 接口。
 *
 * 故意不直接从 AskCommand/debugSink.ts import DebugSink：
 * - QueryEngine 位在顶层，不应依赖 commands/ 子目录
 * - DebugSink 我们只用到 write，鸭子类型即可（TS 结构型兼容）
 *
 * 调用方（runAskWithLLM / ChatCommand）在 debug 开启时传入一个独立的
 * createFileDebugSink（prefix: "ask-llm" | "chat-llm"），落盘到与 AgentEvent
 * 日志文件并列的第二个文件。
 */
export interface LlmLogSink {
  readonly write: (payload: unknown) => void;
}

/**
 * runAgentLoop 的入参。
 */
export interface AgentLoopParams {
  /** 已生效的配置（apiKey/model/maxTokens/maxTurns 等）。 */
  readonly config: ResolvedConfig;
  /** 用户初始 prompt（会被包成最新一条 user message，追加到 initialMessages 之后）。 */
  readonly userPrompt: string;
  /**
   * 可选的历史对话 messages。
   *
   * 设计动机（M2 多轮 REPL）：chat 子命令在每一轮都要把"之前所有轮次的
   * user/assistant/tool_result messages"前置到当前这轮 userPrompt 之前，
   * 这样模型才能看到完整上下文。ask 单 shot 场景不传，行为与之前完全一致。
   *
   * 约束：调用方保证数组顺序已经是合法的对话序列（user→assistant→(tool_result user)→... 配对）。
   * runAgentLoop 不做额外校验；错误序列会被 SDK 在请求阶段拒绝。
   */
  readonly initialMessages?: readonly NovaMessage[];
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
  /**
   * 可选的 LLM 原始调用日志 sink。传入后每轮 LLM 调用会写入三类事件：
   * - llm_request ：发请求前，写下完整 requestParams（model/max_tokens/system/messages/tools）
   * - llm_response：流结束后，写下 SDK finalMessage + stop_reason + 耗时
   * - llm_error   ：流异常或 finalMessage 异常时，写下错误信息 + 耗时
   *
   * 不传即不记录（ask/chat 未开 --debug 时的默认值）。
   */
  readonly llmLogSink?: LlmLogSink;

  // ── M3 权限系统注入（4 个字段同进同出）──────────────────────────────
  //
  // 设计原则：全部可选，不传时 QueryEngine 的行为与 M1/M2 完全一致（无权限检查，
  // 所有 tool_use 直接 execute）。这样保证 QueryEngine 的既有测试不需要改。
  //
  // 一旦传入 permissionMode + permissionStore，QueryEngine 就会在每次执行
  // 工具前调 evaluatePermission；若决策为 ask，再调 permissionProvider；
  // 若 provider 也未传而决策是 ask，则安全从严降级为 deny。

  /** 当前会话的权限模式。不传视为不启用权限系统。 */
  readonly permissionMode?: PermissionMode;
  /** 三层规则存储。不传视为不启用权限系统。 */
  readonly permissionStore?: PermissionStore;
  /** 当决策为 ask 时询问用户的实现。不传且决策为 ask 时会降级为 deny。 */
  readonly permissionProvider?: PermissionProvider;
  /** 用于 file glob 相对化；不传时 evaluatePermission 会 fallback 到 process.cwd()。 */
  readonly cwd?: string;

  // ── M4 Compact 注入（5 个字段同进同出）────────────────────────────────
  //
  // 设计原则：全部可选，不传时主循环行为与 M3 完全一致（无自动 compact、无
  // CLAUDE.md 注入）。这样保证 M3 既有测试不需要改。
  //
  // 一旦传入 autoCompactTracking + autoCompactEnabled=true，主循环会在每轮
  // streamOneTurn 之前调 autoCompactIfNeeded，并按需替换内部 messages 数组、
  // 发 compact_start / compact_end 事件。

  /** 是否启用自动 compact（true 时配合 autoCompactTracking 才生效）。 */
  readonly autoCompactEnabled?: boolean;
  /** 自动 compact 的可变 tracking 状态；调用方通常按"每会话一份"持有。 */
  readonly autoCompactTracking?: AutoCompactTrackingState;
  /**
   * 已加载好的 CLAUDE.md 拼成的字符串（4 层合并 + @include）。不传 = 不注入。
   * 启动时由 chat / ask 命令加载并透传，避免每轮 LLM 调用都重新读盘。
   */
  readonly projectInstructions?: string;

  // ── M10 Hooks 注入（全部可选）─────────────────────────────────────────
  /** 已解析的 hooks 配置；不传或空对象时不会执行任何用户脚本。 */
  readonly hooks?: HooksConfig;
  /** hook stdin JSON 中的 session_id；ask 可省略，chat 传入真实 sessionId。 */
  readonly sessionId?: string;
}

/** 默认 system prompt：让模型知道自己在 nova-code 这个 CLI 里。 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are nova-code, a command-line coding assistant. " +
  "Use the provided tools to inspect the user's project before answering questions about code. " +
  "Be concise and direct.";

/**
 * 构造实际发给 SDK 的 system prompt。CLAUDE.md / project instructions 固定追加在
 * base prompt 之后，保持主循环与 compact forked-agent 请求的 cache key 一致。
 */
export function buildSystemPrompt(params: {
  readonly systemPrompt?: string;
  readonly projectInstructions?: string;
  readonly toolNames?: readonly string[];
}): string {
  const baseSystemPrompt = params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const promptWithTools = shouldIncludeTodoWritePrompt(params)
    ? `${baseSystemPrompt}${TODO_WRITE_SYSTEM_PROMPT}`
    : baseSystemPrompt;
  if (params.projectInstructions === undefined || params.projectInstructions.trim() === "") {
    return promptWithTools;
  }
  return `${promptWithTools}\n\n${params.projectInstructions}`;
}

function shouldIncludeTodoWritePrompt(params: {
  readonly systemPrompt?: string;
  readonly toolNames?: readonly string[];
}): boolean {
  if (params.systemPrompt !== undefined) return false;
  return params.toolNames?.includes(TODO_WRITE_TOOL_NAME) === true;
}

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
  // M4：projectInstructions 拼到 system prompt 末尾（CLAUDE.md 4 层）
  const systemPrompt = buildSystemPrompt({
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    toolNames: tools.map((tool) => tool.name),
    ...(params.projectInstructions !== undefined
      ? { projectInstructions: params.projectInstructions }
      : {}),
  });
  const signal = params.signal ?? new AbortController().signal;
  const client = params.client ?? createAnthropicClient(config);

  // 维护对话历史：先铺 initialMessages（多轮 REPL 的已有历史），再追加
  // 本轮新的 user prompt。ask 单 shot 路径不传 initialMessages，效果与之前一致。
  const messages: NovaMessage[] = [
    ...(params.initialMessages ?? []),
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

    // M4：每轮 streamOneTurn 之前检查是否需要自动 compact
    // 仅在调用方注入了 autoCompactTracking + autoCompactEnabled=true 时启用
    if (params.autoCompactEnabled === true && params.autoCompactTracking !== undefined) {
      const tracking = params.autoCompactTracking;
      // 进入 autoCompactIfNeeded 之前先发 compact_start 让 UI 能展示
      // —— 但只有真的会触发才发；先做一个不调 LLM 的便宜判断
      const outcome = yield* tryAutoCompact({
        messages,
        client,
        model: config.model,
        tracking,
        signal,
        llmLogSink: params.llmLogSink,
        // forked-agent cache 共享：把主循环的 system + tools 透给 compact 请求
        systemPrompt,
        sdkTools,
      });
      if (outcome.replaced) {
        // 被替换的 messages 数组：清空再 push summary message
        messages.length = 0;
        messages.push(outcome.summaryMessage);
      }
    }

    yield { type: "turn_start", turn };

    const { assistantMessage, stopReason } = yield* streamOneTurn({
      client,
      config,
      systemPrompt,
      messages,
      sdkTools,
      signal,
      turn,
      llmLogSink: params.llmLogSink,
    });

    // M4：assistantMessage 自身已携带 usage（streamOneTurn 内部挂的），
    // walk-back-from-end 算法直接走 messages 数组即可，无需单独维护 anchor
    messages.push(assistantMessage);
    if (params.autoCompactTracking !== undefined) {
      params.autoCompactTracking.turnCounter += 1;
    }

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
      permissionMode: params.permissionMode,
      permissionStore: params.permissionStore,
      permissionProvider: params.permissionProvider,
      cwd: params.cwd,
      hooks: params.hooks,
      sessionId: params.sessionId,
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
  /** 当前轮次（从 1 开始），仅用于 llmLogSink 记录。 */
  readonly turn: number;
  /** 可选：记录原始请求/响应的 sink。 */
  readonly llmLogSink?: LlmLogSink;
}

interface StreamOneTurnResult {
  /** assistantMessage 自身已携带 usage（M4 起内嵌到 NovaMessage 上）。 */
  readonly assistantMessage: NovaMessage;
  readonly stopReason: AgentStopReasonEnum;
}

async function* streamOneTurn(
  params: StreamOneTurnParams,
): AsyncGenerator<AgentEvent, StreamOneTurnResult, void> {
  const { client, config, systemPrompt, messages, sdkTools, signal, turn, llmLogSink } = params;

  // SDK 的 MessageStreamParams.tools 类型是 mutable ToolUnion[]，所以这里
  // 把 readonly 数组拷贝成 mutable 切片再传入。
  const requestParams = {
    model: config.model,
    max_tokens: config.maxTokens,
    system: systemPrompt,
    messages: messages.map(toSdkMessageParam),
    ...(sdkTools.length > 0 ? { tools: [...sdkTools] } : {}),
  };

  // 向 llm 日志写请求；任何异常都不得阻断 LLM 调用（fail-safe）。
  if (llmLogSink !== undefined) {
    try {
      llmLogSink.write({
        kind: "llm_request",
        turn,
        model: config.model,
        params: requestParams,
      });
    } catch {
      // sink 内部已做降级；再抛无意义
    }
  }

  logEvent("tengu_api_query", {
    turn,
    model: config.model,
    messageCount: messages.length,
    hasTools: sdkTools.length > 0,
  });

  const startedAt = Date.now();
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
    writeLlmError(llmLogSink, turn, Date.now() - startedAt, error);
    logEvent("tengu_api_error", {
      turn,
      durationMs: Date.now() - startedAt,
      stage: "stream",
      reason: error instanceof Error ? error.name : "unknown",
    });
    throw normalizeSdkError(error);
  }

  // finalMessage 在流结束后立即可用（SDK 内部累积了所有事件）
  let final: SdkMessage;
  try {
    final = await stream.finalMessage();
  } catch (error) {
    writeLlmError(llmLogSink, turn, Date.now() - startedAt, error);
    logEvent("tengu_api_error", {
      turn,
      durationMs: Date.now() - startedAt,
      stage: "finalMessage",
      reason: error instanceof Error ? error.name : "unknown",
    });
    throw normalizeSdkError(error);
  }

  const durationMs = Date.now() - startedAt;

  // 向 llm 日志写响应
  if (llmLogSink !== undefined) {
    try {
      llmLogSink.write({
        kind: "llm_response",
        turn,
        model: config.model,
        stopReason: final.stop_reason,
        durationMs,
        message: final,
      });
    } catch {
      // ignore
    }
  }

  logEvent("tengu_api_success", {
    turn,
    model: config.model,
    durationMs,
    stopReason: final.stop_reason ?? "unknown",
    inputTokens: final.usage?.input_tokens ?? 0,
    outputTokens: final.usage?.output_tokens ?? 0,
  });

  // M4: 把 usage 内嵌到 assistantMessage 自身（claude-code 同款）
  const baseAssistant = fromSdkMessage(final);
  const assistantMessage: NovaMessage =
    final.usage !== undefined
      ? {
          ...baseAssistant,
          usage: {
            input_tokens: final.usage.input_tokens,
            cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: final.usage.cache_read_input_tokens ?? null,
            output_tokens: final.usage.output_tokens,
          },
        }
      : baseAssistant;
  return {
    assistantMessage,
    stopReason: mapStopReason(final.stop_reason),
  };
}

function writeLlmError(
  sink: LlmLogSink | undefined,
  turn: number,
  durationMs: number,
  error: unknown,
): void {
  if (sink === undefined) return;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;
  try {
    sink.write({
      kind: "llm_error",
      turn,
      durationMs,
      error: { name, message },
    });
  } catch {
    // ignore
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 工具执行：两阶段
//   Phase A（串行）：对每个 tool_use 做权限判定，发 permission_request/decision 事件
//   Phase B（并行）：只对决策为 allow 的 tool_use 并行 execute
// 最后按原始顺序组装 ToolResultBlock[] 并 yield tool_result
// ────────────────────────────────────────────────────────────────────────────

interface ExecuteToolsParams {
  readonly toolUses: readonly ToolUseBlock[];
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  // M3 权限系统：全部可选，不传时退化为"全放行"（向后兼容）
  readonly permissionMode?: PermissionMode;
  readonly permissionStore?: PermissionStore;
  readonly permissionProvider?: PermissionProvider;
  readonly cwd?: string;
  readonly hooks?: HooksConfig;
  readonly sessionId?: string;
}

/** Phase A 产出的决策记录；Phase B 按 decision === "allow" 才调度执行。 */
interface ToolDecision {
  readonly use: ToolUseBlock;
  readonly decision: "allow" | "deny";
  readonly denyReason?: string;
  readonly denyPrefix?: string;
}

async function* executeToolsAndYieldEvents(
  params: ExecuteToolsParams,
): AsyncGenerator<AgentEvent, ToolResultBlock[], void> {
  const {
    toolUses,
    tools,
    signal,
    permissionMode,
    permissionStore,
    permissionProvider,
    cwd,
    hooks,
    sessionId,
  } = params;
  const resolvedCwd = cwd ?? process.cwd();

  // 先按声明顺序发出所有 tool_call 事件（与原行为一致，便于 UI 先看到本轮工具列表）
  for (const use of toolUses) {
    yield {
      type: "tool_call",
      toolUseId: use.id,
      toolName: use.name,
      input: use.input,
    };
  }

  // ── Phase A：权限判定（串行，避免并发弹窗）
  const decisions: ToolDecision[] = [];
  for (const use of toolUses) {
    if (signal.aborted) throw new AbortError();

    const preHook = await executePreToolUseHooks({
      use,
      hooks,
      signal,
      cwd: resolvedCwd,
      sessionId,
    });
    yield* yieldHookRecords(preHook.records);
    if (preHook.blocked !== undefined) {
      decisions.push({
        use,
        decision: "deny",
        denyReason: preHook.blocked.reason,
        denyPrefix: "Hook blocked",
      });
      continue;
    }

    const effectiveUse =
      preHook.updatedInput === undefined ? use : { ...use, input: preHook.updatedInput };

    // 未注入权限系统 → 全放行（兼容现有测试与 M1/M2 行为）
    if (permissionMode === undefined || permissionStore === undefined) {
      decisions.push({ use: effectiveUse, decision: "allow" });
      continue;
    }

    const tool = findTool(effectiveUse.name, tools);
    const requiresApproval = tool?.requiresApproval ?? false;
    const evalResult = evaluatePermission({
      mode: permissionMode,
      toolName: effectiveUse.name,
      requiresApproval,
      input: effectiveUse.input,
      rules: permissionStore.getMergedRules(),
      cwd: resolvedCwd,
    });

    if (evalResult.decision === "allow") {
      decisions.push({ use: effectiveUse, decision: "allow" });
      continue;
    }

    if (evalResult.decision === "deny") {
      yield {
        type: "permission_decision",
        toolUseId: effectiveUse.id,
        toolName: effectiveUse.name,
        decision: "deny",
        reason: evalResult.reason,
      };
      decisions.push({ use: effectiveUse, decision: "deny", denyReason: evalResult.reason });
      continue;
    }

    // decision === "ask"：需要 provider；未传则安全从严降级为 deny
    if (permissionProvider === undefined) {
      const reason = `${evalResult.reason} (no permission provider configured, denying by default)`;
      yield {
        type: "permission_decision",
        toolUseId: effectiveUse.id,
        toolName: effectiveUse.name,
        decision: "deny",
        reason,
      };
      decisions.push({ use: effectiveUse, decision: "deny", denyReason: reason });
      continue;
    }

    yield {
      type: "permission_request",
      toolUseId: effectiveUse.id,
      toolName: effectiveUse.name,
      input: effectiveUse.input,
      reason: evalResult.reason,
    };

    const choice = await permissionProvider.requestPermission({
      toolName: effectiveUse.name,
      toolUseId: effectiveUse.id,
      input: effectiveUse.input,
      reason: evalResult.reason,
    });
    const outcome = decisionFromUserChoice(choice);

    // 如果用户选了升级，把规则写回 store（session 只改内存；project/global 会写盘）
    let persisted: "session" | "project" | "global" | undefined;
    if (outcome.decision === "allow" && outcome.persistTo !== undefined) {
      const rule = buildPersistedRule(effectiveUse.name, effectiveUse.input);
      if (rule !== undefined) {
        await permissionStore.addRule(outcome.persistTo, rule);
        persisted = outcome.persistTo;
      }
    }

    yield {
      type: "permission_decision",
      toolUseId: effectiveUse.id,
      toolName: effectiveUse.name,
      decision: outcome.decision,
      reason: `user chose ${choice}`,
      ...(persisted !== undefined ? { persisted } : {}),
    };

    if (outcome.decision === "allow") {
      decisions.push({ use: effectiveUse, decision: "allow" });
    } else {
      decisions.push({
        use: effectiveUse,
        decision: "deny",
        denyReason: `user denied (${choice})`,
      });
    }
  }

  // ── Phase B：对 decision === "allow" 的并行 execute
  const allowedIndexes: number[] = [];
  for (let i = 0; i < decisions.length; i += 1) {
    const d = decisions[i];
    if (d !== undefined && d.decision === "allow") allowedIndexes.push(i);
  }
  const settled = await Promise.allSettled(
    allowedIndexes.map((i) => {
      const d = decisions[i];
      // allowedIndexes 来自 decisions 本身，d 必定存在；noUncheckedIndexedAccess 要求收窄
      if (d === undefined) {
        return Promise.reject(new Error("internal: missing decision entry"));
      }
      return executeOneTool(d.use, tools, signal);
    }),
  );

  // ── Phase C：按原始顺序组装 ToolResultBlock[]
  const results: ToolResultBlock[] = [];
  let settledCursor = 0;
  for (let i = 0; i < decisions.length; i += 1) {
    const d = decisions[i];
    if (d === undefined) continue;
    const use = d.use;

    if (d.decision === "deny") {
      const errorMessage = `${d.denyPrefix ?? "Permission denied"}: ${d.denyReason ?? "no reason"}`;
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
      continue;
    }

    const outcome = settled[settledCursor];
    settledCursor += 1;
    if (outcome === undefined) continue;

    if (outcome.status === "fulfilled") {
      const postHook = await executePostToolUseHooks({
        use,
        content: outcome.value,
        isError: false,
        hooks,
        signal,
        cwd: resolvedCwd,
        sessionId,
      });
      yield* yieldHookRecords(postHook.records);
      const finalContent = applyPostHookContent(outcome.value, postHook);
      const finalIsError = postHook.blocked !== undefined;
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: use.id,
        content: finalContent,
        ...(finalIsError ? { is_error: true } : {}),
      };
      results.push(block);
      yield {
        type: "tool_result",
        toolUseId: use.id,
        toolName: use.name,
        content: finalContent,
        isError: finalIsError,
      };
    } else {
      const errorMessage = describeToolError(outcome.reason, use.name);
      const postHook = await executePostToolUseHooks({
        use,
        content: errorMessage,
        isError: true,
        hooks,
        signal,
        cwd: resolvedCwd,
        sessionId,
      });
      yield* yieldHookRecords(postHook.records);
      const finalContent = applyPostHookContent(errorMessage, postHook);
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: use.id,
        content: finalContent,
        is_error: true,
      };
      results.push(block);
      yield {
        type: "tool_result",
        toolUseId: use.id,
        toolName: use.name,
        content: finalContent,
        isError: true,
      };
    }
  }
  return results;
}

async function executePreToolUseHooks(params: {
  readonly use: ToolUseBlock;
  readonly hooks: HooksConfig | undefined;
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly sessionId: string | undefined;
}): Promise<HookBatchResult> {
  return await executeHookBatch({
    config: params.hooks,
    event: HookEventName.PRE_TOOL_USE,
    cwd: params.cwd,
    signal: params.signal,
    input: {
      hook_event_name: HookEventName.PRE_TOOL_USE,
      session_id: params.sessionId ?? "unknown",
      cwd: params.cwd,
      tool_name: params.use.name,
      tool_input: params.use.input,
      tool_use_id: params.use.id,
    },
  });
}

async function executePostToolUseHooks(params: {
  readonly use: ToolUseBlock;
  readonly content: string;
  readonly isError: boolean;
  readonly hooks: HooksConfig | undefined;
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly sessionId: string | undefined;
}): Promise<HookBatchResult> {
  return await executeHookBatch({
    config: params.hooks,
    event: HookEventName.POST_TOOL_USE,
    cwd: params.cwd,
    signal: params.signal,
    input: {
      hook_event_name: HookEventName.POST_TOOL_USE,
      session_id: params.sessionId ?? "unknown",
      cwd: params.cwd,
      tool_name: params.use.name,
      tool_input: params.use.input,
      tool_use_id: params.use.id,
      tool_response: params.content,
      is_error: params.isError,
    },
  });
}

async function* yieldHookRecords(
  records: readonly HookExecutionRecord[],
): AsyncGenerator<AgentEvent, void, void> {
  for (const record of records) {
    yield {
      type: "hook_result",
      hookEventName: record.hookEventName,
      toolUseId: record.toolUseId,
      toolName: record.toolName,
      command: record.command,
      outcome: record.outcome,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      stdout: record.stdout,
      stderr: record.stderr,
    };
  }
}

function applyPostHookContent(content: string, hook: HookBatchResult): string {
  if (hook.blocked !== undefined) {
    return `PostToolUse hook blocked: ${hook.blocked.reason}`;
  }
  const base = hook.updatedOutput ?? content;
  if (hook.additionalContexts.length === 0) return base;
  return `${base}\n\n[PostToolUse hook context]\n${hook.additionalContexts.join("\n")}`;
}

/**
 * 从工具入参构造一条 behavior=allow 的持久化规则。
 *
 * - Bash：用 "命令名:*"（如 `git status -s` → `git:*`），允许该命令所有后续调用
 * - FileWrite / FileEdit：用原始 file_path 作为 ruleContent
 * - 其它工具：ruleContent 缺省（整个工具允许）
 *
 * 未来 Task 7 可能让 UI 询问用户"要升级成什么形式的规则"（更窄 / 更宽），
 * M3 当前版本采用"命令名 + :*"这种直观的放宽策略。
 */
function buildPersistedRule(toolName: string, input: unknown): PermissionRule | undefined {
  if (toolName === BASH_TOOL_NAME) {
    const command = extractBashCommand(input);
    if (command === undefined) return undefined;
    const first = command.trim().split(/\s+/)[0];
    if (first === undefined || first === "") return undefined;
    return { toolName, ruleContent: `${first}:*`, behavior: "allow" };
  }
  if (isFileWriteToolName(toolName)) {
    const filePath = extractFilePath(input);
    if (filePath === undefined) return undefined;
    return { toolName, ruleContent: filePath, behavior: "allow" };
  }
  return { toolName, behavior: "allow" };
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

/** 把 nova Tool 定义转换为 Anthropic SDK tools 参数。 */
export function toSdkTool(tool: Tool): SdkTool {
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

// ────────────────────────────────────────────────────────────────────────────
// M4：自动 compact 触发的封装
// ────────────────────────────────────────────────────────────────────────────

interface TryAutoCompactParams {
  readonly messages: readonly NovaMessage[];
  readonly client: Anthropic;
  readonly model: string;
  readonly tracking: AutoCompactTrackingState;
  readonly signal: AbortSignal;
  readonly llmLogSink?: LlmLogSink;
  /** Forked-agent cache 共享：与主循环相同的 system prompt。 */
  readonly systemPrompt: string;
  /** Forked-agent cache 共享：与主循环相同的工具定义。 */
  readonly sdkTools: readonly SdkTool[];
}

type TryAutoCompactOutcome =
  | { readonly replaced: true; readonly summaryMessage: NovaMessage }
  | { readonly replaced: false };

/**
 * 在当前轮 streamOneTurn 之前判定 + 触发自动 compact，并把 compact_start /
 * compact_end 事件透传给外层的 yield。
 *
 * 设计选择：把"是否需要 compact"的判断封装到 autoCompactIfNeeded 内（含 circuit
 * breaker、阈值检查），本函数只负责"如果触发了，发对应事件 + 把 summary 传出去"。
 */
async function* tryAutoCompact(
  params: TryAutoCompactParams,
): AsyncGenerator<AgentEvent, TryAutoCompactOutcome, void> {
  const { messages, client, model, tracking, signal, llmLogSink, systemPrompt, sdkTools } = params;

  // 同步预判：阈值未到 / circuit breaker 触发 → 静默跳过，连 compact_start 都不发
  if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { replaced: false };
  }
  const willCompact = shouldAutoCompact({
    messages,
    model,
    enabled: true,
  });
  if (!willCompact) return { replaced: false };

  const preCount = tokenCountWithEstimation(messages);
  yield { type: "compact_start", trigger: "auto", preCompactTokenCount: preCount };

  const outcome = await autoCompactIfNeeded({
    messages,
    client,
    model,
    tracking,
    enabled: true,
    signal,
    ...(llmLogSink !== undefined ? { llmLogSink } : {}),
    systemPrompt,
    sdkTools,
  });

  yield {
    type: "compact_end",
    trigger: "auto",
    preCompactTokenCount: outcome.preCompactTokenCount ?? preCount,
    ...(outcome.postCompactTokenCount !== undefined
      ? { postCompactTokenCount: outcome.postCompactTokenCount }
      : {}),
    ...(outcome.compactionResult !== undefined
      ? { usage: outcome.compactionResult.compactionUsage }
      : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  };

  if (outcome.wasCompacted && outcome.summaryMessage !== undefined) {
    return { replaced: true, summaryMessage: outcome.summaryMessage };
  }
  return { replaced: false };
}
