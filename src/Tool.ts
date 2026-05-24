import type { PlanModeRuntime } from "./services/plan/index.ts";
import type { PermissionMode } from "./types/permissions.ts";

/**
 * 工具系统的核心抽象。
 *
 * 设计原则（与 claude-code 对齐）：
 * - 顶层 src/Tool.ts 持有 Tool 接口；具体工具实现在 src/tools/<ToolName>/<ToolName>.ts
 * - 工具实现是 plain object（带 execute 方法），不要求 class，便于 satisfies 校验字面量
 * - execute 必须返回字符串（会作为 tool_result.content 发回模型）
 * - 工具内部抛错由 agent loop 包成 ToolExecutionError 并以 is_error=true 反馈给模型
 *
 * 与 claude-code 的小幅偏离已在 docs/design/M1-tools.md §3.3 显式声明。
 */

/**
 * 工具的 JSON Schema 入参定义。
 *
 * 直接对齐 Anthropic API 的 tool.input_schema 字段（必须是 JSON Schema 的
 * object 类型）。我们不做更深的类型约束 —— 上层用 satisfies / as const
 * 就能拿到字面量类型推断。
 */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

/**
 * 传给 Tool.execute 的运行时上下文。
 *
 * M1 范围内仅含 abort signal。M11 起注入可选 sub-agent runtime，
 * 让 AgentTool 能在不 import QueryEngine 的前提下派生子 agent。
 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  /** 当前工具执行时的有效权限模式；Plan Mode 工具用它记录进入前模式。 */
  readonly permissionMode?: PermissionMode;
  /** M15：Plan Mode 状态机，供 EnterPlanMode / ExitPlanMode 工具切换状态。 */
  readonly planModeRuntime?: PlanModeRuntime;
  readonly subAgentRuntime?: SubAgentRuntime;
}

/** AgentTool 请求 QueryEngine 派生子 agent 时的最小参数。 */
export interface SubAgentRunParams {
  readonly description: string;
  readonly prompt: string;
  readonly subagentType?: string;
}

/** 子 agent 完成后返回给 AgentTool 的摘要结果。 */
export interface SubAgentRunResult {
  readonly agentType: string;
  readonly turns: number;
  readonly summary: string;
}

/**
 * QueryEngine 注入给工具的子 agent runtime。
 *
 * 放在 Tool.ts 而不是 AgentTool.ts 的原因：ToolExecutionContext 是所有工具共享的
 * 边界类型；AgentTool 只能依赖这个稳定接口，避免形成 QueryEngine ↔ tools 的循环。
 */
export interface SubAgentRuntime {
  readonly run: (params: SubAgentRunParams) => Promise<SubAgentRunResult>;
}

/**
 * Tool 抽象。一个工具 = 名字 + 描述 + 入参 schema + 一个执行函数。
 *
 * - `name`：LLM 收到的工具标识。M1 起统一使用 PascalCase（如 "Bash" / "FileEdit"），
 *   对齐 claude-code，避免后续 resume / debug log 兼容性问题
 * - `description`：发给 LLM 的工具说明，影响 LLM 选择工具的准确性
 * - `input_schema`：JSON Schema，用于 LLM 知道如何构造入参
 * - `execute`：实际执行逻辑，可同步或异步；可以抛任意 Error，agent loop 会捕获
 * - `requiresApproval`：M1 仅声明，agent loop 暂不消费（M3 权限系统接管时启用）
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ToolInputSchema;
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ) => string | Promise<string>;
  /**
   * 是否需要用户审批后才能执行（写权 / 副作用大的工具应标 true）。
   *
   * M1 范围内仅作为 metadata 字段存在，agent loop 不读取。M3 权限系统上线后由
   * userApprover 模块根据此字段决定是否阻塞工具执行等待用户确认。
   */
  readonly requiresApproval?: boolean;
}
