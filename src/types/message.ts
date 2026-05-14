/**
 * LLM 对话消息 / 事件的核心领域类型。
 *
 * M1.5 起从 src/llm/types.ts 搬到此处：顶层 src/types/ 与 claude-code
 * 的 src/types/ 一致，作为跨模块共享的领域类型聚合点。
 *
 * 设计取舍：
 * - 不直接暴露 @anthropic-ai/sdk 的 Message/MessageParam 类型给上层，
 *   而是定义 nova-code 自己的薄类型（NovaMessage / NovaContentBlock）。
 *   原因：SDK 的 ContentBlockParam 是 25+ 项的巨型联合类型（含 PDF / image /
 *   web search / code execution 等大量 nova-code 暂不支持的形态）。暴露原始
 *   类型会让消费方被迫处理大量永远收不到的分支。
 * - SDK 类型仅在 services/api/client.ts / QueryEngine.ts 内部使用，
 *   并通过 toSdkMessages() 转换。
 * - 类型用 readonly 标记不可变属性，匹配 messages 数组追加而非原地变更的语义。
 */

import type { PermissionDecision, PermissionRuleSource } from "./permissions.ts";

/** 一段文本内容块。 */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** 模型请求调用某个工具。由 assistant message 产生。 */
export interface ToolUseBlock {
  readonly type: "tool_use";
  /** SDK 分配的唯一 id，必须原样回传到对应的 tool_result。 */
  readonly id: string;
  /** 被调用的工具名（必须匹配某个已注册 Tool.name）。 */
  readonly name: string;
  /** 工具入参（已由 SDK 解析为对象）。 */
  readonly input: Readonly<Record<string, unknown>>;
}

/** 工具执行结果。由 user message 包装，发回模型。 */
export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

/** nova-code 当前支持的全部内容块类型。 */
export type NovaContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** 角色枚举。assistant 由模型产生，user 由调用方或 tool_result 产生。 */
export enum MessageRoleEnum {
  USER = "user",
  ASSISTANT = "assistant",
}

/**
 * Anthropic SDK 在 message.usage 上返回的最小子集（用于 M4 token 计数）。
 *
 * 不直接 import SDK 的 Usage 类型：
 * - SDK 类型可能跨版本变形（SDK 0.x → 1.x 已经改过）
 * - QueryEngine 在 streamOneTurn 完成后只取这 4 个字段构造 ApiUsage 挂到 assistant message
 */
export interface ApiUsage {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly output_tokens: number;
}

/**
 * 一条对话消息。可以是纯文本（content 为字符串）或结构化内容块数组。
 * 与 Anthropic SDK 的 MessageParam 形状对齐，便于 toSdkMessages 直接透传。
 *
 * M4 起：assistant message 可携带 SDK 响应的 usage，用于 tokenCountWithEstimation
 * 走 claude-code 同款 walk-back-from-end 算法。user message 永远 undefined。
 * 序列化到 sessionStore JSONL 时 usage 会一同写出；缺失字段对加载向后兼容。
 */
export interface NovaMessage {
  readonly role: MessageRoleEnum;
  readonly content: string | readonly NovaContentBlock[];
  /** 仅 assistant 消息有；M4 token 计数用。 */
  readonly usage?: ApiUsage;
}

/**
 * Agent loop 对外发射的事件流。
 * 调用方按需订阅——比如 ask 命令只关心 text_delta 用于 stdout 流式打印。
 *
 * 与 SDK 的 RawMessageStreamEvent 不同：这里是 nova-code 自己的高层语义事件，
 * 隐藏了 content_block_start/stop 等底层细节。
 */
export type AgentEvent =
  /** 一轮 LLM 调用即将开始（turn 从 1 开始计数）。 */
  | { readonly type: "turn_start"; readonly turn: number }
  /** 模型流式产出的文本增量。 */
  | { readonly type: "text_delta"; readonly delta: string }
  /** 一轮 LLM 调用结束，附带完整 assistant message 和停止原因。 */
  | {
      readonly type: "turn_end";
      readonly turn: number;
      readonly message: NovaMessage;
      readonly stopReason: AgentStopReasonEnum;
    }
  /** 即将执行某个工具调用（一次 turn_end 后可能有 0 个或多个）。 */
  | {
      readonly type: "tool_call";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  /** 工具执行完成，包含返回值或错误信息。 */
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError: boolean;
    }
  /** 整个 agent loop 结束。 */
  | {
      readonly type: "done";
      readonly turns: number;
      readonly finalMessage: NovaMessage;
    }
  /**
   * 权限引擎给出 ask 决策，调用方即将询问用户。主要用于 UI 展示“等待确认”状态
   * 和令论消息埋点。逐条在 tool_call 之后 / tool_result 之前出现。
   */
  | {
      readonly type: "permission_request";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
      /** engine 给出的 ask 原因（人类可读，用于 UI 提示和日志）。 */
      readonly reason: string;
    }
  /**
   * 权限决策已落定（用户选择或 engine 直接 allow/deny）。UI 可用来渲染“✓ 允许”/
   * “✗ 拒绝”，也便于 debug sink 溯源“为什么这次被 deny 了”。
   */
  | {
      readonly type: "permission_decision";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly decision: PermissionDecision;
      /** engine / 用户给出的文字原因。 */
      readonly reason: string;
      /** 若用户选 allow-always-*，标识升级到哪一层 source。 */
      readonly persisted?: PermissionRuleSource;
    }
  /**
   * M4：上下文压缩即将开始。trigger 区分自动 vs 手动；preCompactTokenCount
   * 是触发时估算的当前上下文 token 数，用于 UI 提示与日志溯源。
   */
  | {
      readonly type: "compact_start";
      readonly trigger: CompactTrigger;
      readonly preCompactTokenCount: number;
    }
  /**
   * M4：上下文压缩结束。成功时 error 为 undefined 且 postCompactTokenCount
   * 反映替换后的估算上下文 token 数；失败时 error 给出 message，调用方决定
   * 是否要 surface 给用户（自动 compact 通常静默重试，手动 /compact 必报）。
   */
  | {
      readonly type: "compact_end";
      readonly trigger: CompactTrigger;
      readonly preCompactTokenCount: number;
      readonly postCompactTokenCount?: number;
      /** compact 自身 LLM 调用的 usage；成功时用于 M5 cost tracker。 */
      readonly usage?: ApiUsage;
      readonly error?: string;
    };

/**
 * compact 触发来源。
 *  - "auto"   ：QueryEngine 在 turn 间检查阈值后自动触发
 *  - "manual" ：用户 /compact 斜杠命令显式触发
 */
export type CompactTrigger = "auto" | "manual";

/**
 * Agent loop 的终止原因。
 * 与 SDK 的 StopReason 字段对齐，但只暴露 nova-code 关心的子集。
 */
export enum AgentStopReasonEnum {
  /** 模型给出最终答案，正常结束。 */
  END_TURN = "end_turn",
  /** 模型要求调用工具（loop 会继续）。 */
  TOOL_USE = "tool_use",
  /** 输出 token 超限。 */
  MAX_TOKENS = "max_tokens",
  /** 模型自行选择 stop_sequence 终止。 */
  STOP_SEQUENCE = "stop_sequence",
  /** 模型拒绝回答。 */
  REFUSAL = "refusal",
  /** 罕见：模型主动暂停（如长任务）。 */
  PAUSE_TURN = "pause_turn",
}
