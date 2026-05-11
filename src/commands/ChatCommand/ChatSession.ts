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
import { type LlmLogSink, runAgentLoop } from "../../QueryEngine.ts";
import type { Tool } from "../../Tool.ts";
import {
  type AgentEvent,
  MessageRoleEnum,
  type NovaMessage,
  type ToolResultBlock,
} from "../../types/message.ts";

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
        // done / text_delta / tool_call 不影响内部 messages，只是转发给上层
        case "done":
        case "text_delta":
        case "tool_call":
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
