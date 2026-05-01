/**
 * LLM 子系统的错误层级。
 *
 * 设计原则：
 * - 用具体的 Error 子类传达"出在哪一层"，调用方可以 instanceof 精准捕获
 * - cause 字段透传原始错误（Anthropic SDK 的 APIError 等），便于调试
 * - 不在错误对象里塞结构化业务字段；信息全部进 message，简单
 */

/**
 * 配置相关错误：API key 缺失、配置文件格式错误、必需字段缺失。
 * 由 src/config/config.ts 抛出。
 *
 * 继承自 Error；构造函数无需重写——Error 已支持 (message, { cause }) 签名。
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Anthropic API 调用失败。包装 SDK 抛出的 APIError / 网络错误。
 * 包含 status 字段，便于调用方区分 4xx（用户问题）vs 5xx（服务端问题）。
 */
export class LLMApiError extends Error {
  override readonly name = "LLMApiError";
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
  }
}

/**
 * 工具执行失败。Tool.execute() 抛出的错误会被包成此类型。
 * agent loop 会把这个错误的 message 当作 tool_result 反馈给模型，
 * 让模型自己决定下一步（重试、换工具、还是放弃）。
 */
export class ToolExecutionError extends Error {
  override readonly name = "ToolExecutionError";
  readonly toolName: string;

  constructor(toolName: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.toolName = toolName;
  }
}

/**
 * 用户主动中断（Ctrl+C / AbortSignal.abort()）。
 * 与其他错误区分开，便于上层只打印简短提示而非堆栈。
 */
export class AbortError extends Error {
  override readonly name = "AbortError";

  constructor(message = "Operation aborted by user.") {
    super(message);
  }
}

/**
 * Agent loop 超出 maxTurns 上限。
 * 通常意味着模型陷入了工具调用循环，需要人工介入。
 */
export class MaxTurnsExceededError extends Error {
  override readonly name = "MaxTurnsExceededError";
  readonly turns: number;

  constructor(turns: number) {
    super(
      `Agent loop exceeded maxTurns=${turns}. The model kept calling tools without producing a final answer.`,
    );
    this.turns = turns;
  }
}
