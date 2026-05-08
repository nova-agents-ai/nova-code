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
