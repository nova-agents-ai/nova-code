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
