/**
 * ChatSession —— 多轮对话的状态持有者。
 *
 * 职责（对齐设计稿 §5）：
 * 1. 保存当前对话的 messages（顺序严格遵循 user→assistant→tool_result_user→... 链条）
 * 2. sendTurn：以现有 messages 作为 initialMessages 调 runAgentLoop，
 *    按事件流增量追加新消息；loop 全流程成功才"原子提交"到内部状态，
 *    中途抛错（abort / LLM error）**不会**让 messages 残留半条孤儿 user
 * 3. clear / snapshot / restore：为 `/clear`、`/save`、`/load` 提供原子 API
 *
 * 与 runAgentLoop 的分工：
 * - runAgentLoop 的内部 messages 数组不外泄；ChatSession 通过订阅事件流
 *   （turn_end、tool_result）**重建**一份等价的对话历史
 * - 重建逻辑严格对齐 QueryEngine 里的 push 顺序：
 *     · turn_end 时 push assistant message
 *     · 一批 tool_result 事件累积后，在下一个 turn_start（表示模型要回了）
 *       前 flush 成一条 user(content: tool_result blocks[]) 消息
 *   这样 ChatSession 看到的历史完全等于 runAgentLoop 内部维护的 messages。
 *
 * 之所以要"原子提交"：如果 sendTurn 中途抛错，当前 turn 可能追加了
 * "user + assistant(含 tool_use)" 但没有对应的 tool_result，下一轮把这份残
 * 缺历史再发给 SDK 会被拒（tool_use 必须配对 tool_result）。快照 → 重建 →
 * 成功后替换的写法避免这个隐患。
 */

import type { ResolvedConfig } from "../../config/config.ts";
import { buildSystemPrompt, type LlmLogSink, runAgentLoop, toSdkTool } from "../../QueryEngine.ts";
import { createAnthropicClient } from "../../services/api/client.ts";
import type { AutoCompactTrackingState } from "../../services/compact/autoCompact.ts";
import { compactConversation } from "../../services/compact/compact.ts";
import type { HooksConfig } from "../../services/hooks/types.ts";
import type { PermissionProvider } from "../../services/permissions/PermissionProvider.ts";
import type { PermissionStore } from "../../services/permissions/permissionStore.ts";
import type { Tool } from "../../Tool.ts";
import {
  type AgentEvent,
  type ApiUsage,
  MessageRoleEnum,
  type NovaMessage,
  type ToolResultBlock,
} from "../../types/message.ts";
import type { PermissionMode } from "../../types/permissions.ts";

/** 会话元信息（写入 JSONL 首行的 meta 行）。 */
export interface SessionMeta {
  readonly sessionId: string;
  readonly model: string;
  /** ISO 8601 timestamp。 */
  readonly createdAt: string;
}

/**
 * sendTurn 的运行上下文。
 *
 * agentLoop 走依赖注入是为了单测可以不碰真实 Anthropic SDK。
 */
export interface ChatTurnContext {
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  /**
   * 可选：注入假的 agent loop（测试用）；生产路径使用默认的 runAgentLoop。
   * 签名与 runAgentLoop 等价；类型特意写成 typeof runAgentLoop 以保持一致。
   */
  readonly agentLoop?: typeof runAgentLoop;
  /**
   * 可选：debug 模式下用于记录原始 LLM 请求/响应的 sink。
   * 由 ChatCommand 创建并透传；ChatSession 原样转交给 runAgentLoop。
   */
  readonly llmLogSink?: LlmLogSink;
  // ── M3 权限系统注入（全部可选，透传给 runAgentLoop）────────────────────
  readonly permissionMode?: PermissionMode;
  readonly permissionStore?: PermissionStore;
  readonly permissionProvider?: PermissionProvider;
  readonly cwd?: string;
  // ── M4 Compact 注入（全部可选，透传给 runAgentLoop）─────────────────────
  readonly autoCompactEnabled?: boolean;
  readonly autoCompactTracking?: AutoCompactTrackingState;
  readonly projectInstructions?: string;
  // ── M10 Hooks 注入（透传给 runAgentLoop）───────────────────────────────
  readonly hooks?: HooksConfig;
}

/**
 * /compact 斜杠命令调用 ChatSession.compact() 时的上下文。
 *
 * 设计动机：与 sendTurn 用同一个 ChatTurnContext 太重 —— compact 不需要
 * tools / permissionStore / projectInstructions（compact 调用本身不带工具），
 * 单独定义专用 ctx 更清晰。
 */
export interface ChatCompactContext {
  readonly config: ResolvedConfig;
  readonly signal: AbortSignal;
  readonly llmLogSink?: LlmLogSink;
  /** Forked-agent cache 共享：与主循环相同的 system prompt。 */
  readonly systemPrompt?: string;
  /** Forked-agent cache 共享：启动时加载好的 CLAUDE.md / project instructions。 */
  readonly projectInstructions?: string;
  /** Forked-agent cache 共享：与主循环相同的工具定义。 */
  readonly tools?: readonly Tool[];
  /** 测试注入：覆盖 Anthropic client；不传时按 config 创建。 */
  readonly clientFactory?: typeof createAnthropicClient;
}

/** ChatSession.compact() 的返回，便于 /compact 命令打回执给用户。 */
export interface ChatCompactOutcome {
  readonly preCompactTokenCount: number;
  readonly postCompactTokenCount: number;
  readonly compactedMessages: number;
  /** compact 这次 LLM 调用本身的 token usage；M5 cost tracker 用。 */
  readonly compactionUsage: ApiUsage;
}

export class ChatSession {
  private _meta: SessionMeta;
  private messages: NovaMessage[];

  constructor(meta: SessionMeta, initialMessages: readonly NovaMessage[] = []) {
    this._meta = meta;
    this.messages = [...initialMessages];
  }

  get meta(): SessionMeta {
    return this._meta;
  }

  /**
   * 跑一轮完整的 agent loop，返回事件流给调用方直接渲染。
   *
   * 内部实现用"本地快照 + 成功才提交"保护 this.messages 的合法性，
   * 详见文件头设计说明。
   */
  async *sendTurn(userInput: string, ctx: ChatTurnContext): AsyncGenerator<AgentEvent, void, void> {
    // 本轮的本地副本：成功收尾才回写到 this.messages
    const newMessages: NovaMessage[] = [
      ...this.messages,
      { role: MessageRoleEnum.USER, content: userInput },
    ];
    // 传给 runAgentLoop 的 initialMessages 必须不含本轮新 user（它内部会自己加）
    const initialMessages = [...this.messages];

    const agentLoop = ctx.agentLoop ?? runAgentLoop;
    const gen = agentLoop({
      config: ctx.config,
      userPrompt: userInput,
      initialMessages,
      tools: ctx.tools,
      signal: ctx.signal,
      ...(ctx.llmLogSink !== undefined ? { llmLogSink: ctx.llmLogSink } : {}),
      ...(ctx.permissionMode !== undefined ? { permissionMode: ctx.permissionMode } : {}),
      ...(ctx.permissionStore !== undefined ? { permissionStore: ctx.permissionStore } : {}),
      ...(ctx.permissionProvider !== undefined
        ? { permissionProvider: ctx.permissionProvider }
        : {}),
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      ...(ctx.autoCompactEnabled !== undefined
        ? { autoCompactEnabled: ctx.autoCompactEnabled }
        : {}),
      ...(ctx.autoCompactTracking !== undefined
        ? { autoCompactTracking: ctx.autoCompactTracking }
        : {}),
      ...(ctx.projectInstructions !== undefined
        ? { projectInstructions: ctx.projectInstructions }
        : {}),
      ...(ctx.hooks !== undefined ? { hooks: ctx.hooks } : {}),
      sessionId: this._meta.sessionId,
    });

    // 累积本轮待 flush 的 tool_result 块；下一个 turn_start 到达时打包成 user 消息
    const pending: ToolResultBlock[] = [];

    for await (const event of gen) {
      switch (event.type) {
        case "turn_start":
          if (pending.length > 0) {
            newMessages.push({
              role: MessageRoleEnum.USER,
              content: pending.splice(0),
            });
          }
          break;
        case "turn_end":
          newMessages.push(event.message);
          break;
        case "tool_result":
          pending.push({
            type: "tool_result",
            tool_use_id: event.toolUseId,
            content: event.content,
            // is_error 只有在 true 时才写出；保持 NovaMessage 原有语义
            ...(event.isError ? { is_error: true } : {}),
          });
          break;
        // done / text_delta / tool_call / permission_* 不影响内部 messages，只是转发给上层
        case "done":
        case "text_delta":
        case "tool_call":
        case "permission_request":
        case "permission_decision":
        case "hook_result":
          break;
      }
      yield event;
    }

    // 走到这里说明 generator 正常耗尽（最后一个事件必是 done）；
    // 若中途抛错则 `this.messages = newMessages` 不会被执行，自动 rollback
    this.messages = newMessages;
  }

  /** 清空对话历史（`/clear` 命令用）。meta 不变。 */
  clear(): void {
    this.messages = [];
  }

  /**
   * 强制压缩当前对话（`/compact` 命令用）。
   *
   * 与 sendTurn 同样的"快照 + 成功才提交"语义：compact 中途抛错（abort / LLM
   * error / 不足 N 条消息）则 messages 保持原状，不会出现"半压缩"中间态。
   *
   * 成功时直接重置 messages = [summaryMessage]（claude-code /compact 同语义）。
   *
   * 不接完整 ChatTurnContext —— compact 不需要权限；但会复用主循环的
   * system/tools 让 forked-agent compact 请求与主会话共享 prompt cache。
   */
  async compact(ctx: ChatCompactContext, customInstructions?: string): Promise<ChatCompactOutcome> {
    if (this.messages.length === 0) {
      throw new Error("No messages to compact yet.");
    }

    const clientFactory = ctx.clientFactory ?? createAnthropicClient;
    const client = clientFactory(ctx.config);

    // 在调用前先记下原 messages 的副本；compactConversation 抛错时不会动 this.messages
    const snapshot = this.messages;
    const result = await compactConversation({
      messages: snapshot,
      client,
      model: ctx.config.model,
      trigger: "manual",
      ...(customInstructions !== undefined ? { customInstructions } : {}),
      signal: ctx.signal,
      ...(ctx.llmLogSink !== undefined ? { llmLogSink: ctx.llmLogSink } : {}),
      ...(ctx.systemPrompt !== undefined || ctx.projectInstructions !== undefined
        ? {
            systemPrompt: buildSystemPrompt({
              ...(ctx.systemPrompt !== undefined ? { systemPrompt: ctx.systemPrompt } : {}),
              ...(ctx.projectInstructions !== undefined
                ? { projectInstructions: ctx.projectInstructions }
                : {}),
            }),
          }
        : {}),
      ...(ctx.tools !== undefined ? { sdkTools: ctx.tools.map(toSdkTool) } : {}),
    });

    // 走到这里说明 compact 成功 → 原子替换
    const compactedCount = snapshot.length;
    this.messages = [result.summaryMessage];
    return {
      preCompactTokenCount: result.preCompactTokenCount,
      postCompactTokenCount: result.postCompactTokenCount,
      compactedMessages: compactedCount,
      compactionUsage: result.compactionUsage,
    };
  }

  /**
   * 返回当前对话历史的只读快照（`/save` 命令用）。
   * 返回新数组副本，防止调用方误改内部状态。
   */
  snapshot(): readonly NovaMessage[] {
    return [...this.messages];
  }

  /**
   * 用指定的 meta + messages 重置会话（`/load` 命令用）。
   * 不做结构校验：约定调用方（sessionStore）已经验过 JSONL 合法性。
   */
  restore(meta: SessionMeta, messages: readonly NovaMessage[]): void {
    this._meta = meta;
    this.messages = [...messages];
  }
}
