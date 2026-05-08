/**
 * API 层错误：Anthropic SDK 调用失败的统一包装。
 *
 * 与 claude-code 的 src/services/api/errors.ts 相比，这里只保留"调用失败
 * 包装类 + status"，不包含 OAuth / Bedrock / rate-limit 特化逻辑 ——
 * 那些是 M12 多 provider 阶段的范畴。
 */

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
