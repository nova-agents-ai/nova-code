/**
 * API 错误分类工具 —— 判断一次 Anthropic API 调用失败是否可重试，
 * 并从错误上解析出 Retry-After 等语义。
 *
 * 与 claude-code 的 src/services/api/errorUtils.ts 对应，但只保留 M1.5 必需
 * 的子集；不处理 SSL/TLS 错误分类 / cause 链深度遍历（M12 多 provider 再加）。
 */

import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { AbortError } from "../../errors/index.ts";
import { LLMApiError } from "./errors.ts";

/**
 * 可重试的 HTTP 状态码集合。
 *
 * 选型：
 * - 429：rate limit，明确应重试（常带 Retry-After）
 * - 502/503/504：上游网关 / 服务不可用，典型瞬时错误
 * - 529：Anthropic 专用的 Overloaded 状态（claude-code withRetry 也视作可重试）
 *
 * 400/401/403/404 明确不重试（用户输入或权限问题）。
 */
const RETRYABLE_STATUS_CODES = new Set<number>([429, 502, 503, 504, 529]);

/**
 * 可重试的网络错误 code 集合（来自 Node 的 libuv / OpenSSL）。
 * 这类错误常出现在连接被远端重置 / 超时 / DNS 抖动的场景。
 */
const RETRYABLE_NETWORK_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * 判断一次错误是否属于"用户主动中断"。
 *
 * 中断永远不重试 —— 否则用户按 Ctrl+C 之后仍看到重试循环，违反直觉。
 */
export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof AbortError) return true;
  if (error instanceof APIUserAbortError) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/**
 * 判断一次错误是否可重试。
 *
 * 语义：
 * - Abort 类错误 → 否
 * - LLMApiError with retryable status → 是
 * - 原生 APIError with retryable status → 是
 * - Error with retryable `code` property → 是（网络层抖动）
 * - 其它 → 否
 */
export function isRetryableError(error: unknown): boolean {
  if (isAbortLikeError(error)) return false;

  if (error instanceof LLMApiError) {
    return error.status !== undefined && RETRYABLE_STATUS_CODES.has(error.status);
  }

  if (error instanceof APIError) {
    return error.status !== undefined && RETRYABLE_STATUS_CODES.has(error.status);
  }

  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return RETRYABLE_NETWORK_CODES.has(error.code);
  }

  return false;
}

/**
 * 从错误中解析出 Retry-After 头（毫秒）。
 *
 * Anthropic SDK 的 APIError.headers 是 Web Fetch 的 `Headers` 对象（SDK v1.x）。
 * Retry-After 规范支持两种格式：
 * - 秒数（整数）：`Retry-After: 120`
 * - HTTP-Date：`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`
 *
 * 我们优先尝试秒数形式；HTTP-Date 形式罕见于 rate limit 场景，暂不处理
 * （解析失败返回 undefined，调用方 fallback 到指数退避）。
 *
 * 返回 undefined 表示"未指定或解析失败"。
 */
export function getRetryAfterMs(error: unknown): number | undefined {
  const raw = extractRetryAfterRaw(error);
  if (raw === undefined || raw === "") return undefined;

  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  return undefined;
}

/**
 * 从 APIError / 含 cause 的自定义错误中取 Retry-After 头的原始值。
 * 支持两种 headers 形式：
 * - Web Fetch `Headers` 对象（生产环境 SDK 用的）
 * - `Record<string, string>`（单测 / 第三方包构造的轻量 mock）
 */
function extractRetryAfterRaw(error: unknown): string | undefined {
  const headers = extractHeaders(error);
  if (headers === undefined) return undefined;

  if (isHeadersLike(headers)) {
    const v = headers.get("retry-after");
    return v === null ? undefined : v;
  }

  // 不区分大小写查找（服务器返回可能是 Retry-After 或 retry-after）
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "retry-after") return value;
  }
  return undefined;
}

/** 从 APIError / 含 cause 的自定义错误中取 headers 字段。 */
function extractHeaders(error: unknown): Headers | Record<string, string> | undefined {
  if (error instanceof APIError) {
    if (isHeadersLike(error.headers)) return error.headers;
    if (isStringRecord(error.headers)) return error.headers;
  }
  if (error instanceof LLMApiError && error.cause instanceof APIError) {
    if (isHeadersLike(error.cause.headers)) return error.cause.headers;
    if (isStringRecord(error.cause.headers)) return error.cause.headers;
  }
  return undefined;
}

/** 判断是 Web Fetch 的 Headers 对象（有 `.get()` 方法）。 */
function isHeadersLike(value: unknown): value is Headers {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object") return false;
  for (const v of Object.values(value)) {
    if (typeof v !== "string") return false;
  }
  return true;
}
