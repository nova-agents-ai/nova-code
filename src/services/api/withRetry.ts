/**
 * 指数退避重试薄层。
 *
 * 与 claude-code 的 src/services/api/withRetry.ts 对应，但只保留 M1.5 必需
 * 的核心子集（约 120 行）：
 * - 指数退避（base * 2^(attempt-1)，±25% 抖动）
 * - 尊重 Retry-After 头（429/5xx 时优先用服务端建议）
 * - 尊重 AbortSignal（执行中 + 等待中都可中断）
 * - 通过 isRetryableError 判定哪些错误可重试
 *
 * 暂不覆盖的特性（M12 再加）：
 * - Fast mode cooldown（与 RL 模式耦合）
 * - OAuth 401 token 刷新
 * - 多 provider（Bedrock/Vertex）特有错误码
 * - 多路径 fallback model
 *
 * 当前 QueryEngine 依赖 Anthropic SDK 自带的 maxRetries=2，未强制走 withRetry；
 * 本文件提供给需要在 SDK retry 之外做"会话级退避"的场景（如 M2 调度器）。
 */

import { AbortError } from "../../errors/index.ts";
import { logEvent } from "../analytics/index.ts";
import { getRetryAfterMs, isAbortLikeError, isRetryableError } from "./errorUtils.ts";

/**
 * 默认最大重试次数。第 1 次是原始调用，之后最多再试 MAX_ATTEMPTS - 1 次。
 * 选 3：覆盖绝大多数瞬时抖动；更多次重试会显著增加用户等待。
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** 默认初始退避延迟（毫秒）。第 2 次调用前等 INITIAL_DELAY_MS。 */
export const DEFAULT_INITIAL_DELAY_MS = 500;

/** 默认退避上限（毫秒）。防止指数爆炸 —— 16s 后不再增大。 */
export const DEFAULT_MAX_DELAY_MS = 16_000;

export interface WithRetryOptions {
  /**
   * 最大尝试次数（包含首次）。默认 3。
   * maxAttempts=1 等价于不重试。
   */
  readonly maxAttempts?: number;
  /** 初始退避延迟（毫秒）。默认 500。 */
  readonly initialDelayMs?: number;
  /** 退避上限（毫秒）。默认 16_000。 */
  readonly maxDelayMs?: number;
  /** 用户中断信号。中断时停止重试，剩余 sleep 立即抛 AbortError。 */
  readonly signal?: AbortSignal;
  /**
   * 可选的 sleep 实现，测试注入用。默认 setTimeout。
   * 实现应尊重 AbortSignal —— 被中断时立即 resolve（withRetry 内部会再检查 signal）。
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * 执行 `fn`，失败时按策略重试。
 *
 * @param fn 实际业务函数。会收到当前 attempt 编号（从 1 开始）。
 * @param options 重试策略。
 * @returns `fn` 第一次成功返回的值。
 * @throws 最后一次尝试的错误；或 AbortError（被 signal 中断时）。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const signal = options.signal;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new AbortError();
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // 用户中断 → 永不重试，直接抛
      if (isAbortLikeError(error)) {
        throw error;
      }

      // 非可重试错误 → 立即抛（留给上层处理）
      if (!isRetryableError(error)) {
        throw error;
      }

      // 已经是最后一次 → 抛出原始错误
      if (attempt >= maxAttempts) {
        throw error;
      }

      // 计算延迟：优先用服务端 Retry-After，否则指数退避 + 抖动
      const retryAfterMs = getRetryAfterMs(error);
      const delay = computeDelayMs({
        attempt,
        initialDelayMs,
        maxDelayMs,
        retryAfterMs,
      });

      logEvent("tengu_api_retry", {
        attempt,
        nextDelayMs: delay,
        retryAfter: retryAfterMs ?? null,
        reason: error instanceof Error ? error.name : "unknown",
      });

      await sleep(delay, signal);

      // 等待过程中被中断 → 抛 AbortError
      if (signal?.aborted) {
        throw new AbortError();
      }
    }
  }

  // 不可达（循环内必然 return 或 throw），保留给 TS 收窄用
  throw lastError ?? new Error("withRetry: exhausted attempts without error capture");
}

// ────────────────────────────────────────────────────────────────────────────
// 延迟计算
// ────────────────────────────────────────────────────────────────────────────

interface ComputeDelayParams {
  readonly attempt: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryAfterMs: number | undefined;
}

/**
 * 计算下一次重试前的等待时长。
 *
 * - 优先使用服务端 Retry-After（若存在，不抖动、不封顶）
 * - 否则 initialDelayMs * 2^(attempt-1)，上限 maxDelayMs，±25% 抖动
 */
export function computeDelayMs(params: ComputeDelayParams): number {
  if (params.retryAfterMs !== undefined) {
    return params.retryAfterMs;
  }
  const exp = params.initialDelayMs * 2 ** (params.attempt - 1);
  const capped = Math.min(exp, params.maxDelayMs);
  // ±25% 抖动，避免 thundering herd；jitter 以 capped 为基准
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(capped + jitter));
}

// ────────────────────────────────────────────────────────────────────────────
// 默认 sleep（setTimeout + signal 取消）
// ────────────────────────────────────────────────────────────────────────────

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
