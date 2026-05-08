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
 * M1 范围内仅含 abort signal。后续 milestone 可扩展（cwd、logger、权限校验等）—— 见 §2.3 设计稿约束。
 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
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
