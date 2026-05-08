/**
 * withRetry 单元测试。
 *
 * 目标：
 * 1. 成功首次 → 不重试
 * 2. 可重试错误 → 按策略重试直到成功
 * 3. 可重试错误耗尽次数 → 抛最后一次错误
 * 4. 非可重试错误 → 立即抛
 * 5. Abort 错误 → 永不重试
 * 6. 执行中 signal.abort → 抛 AbortError
 * 7. Retry-After 头 → delay 用服务端建议
 * 8. computeDelayMs 上限 / 抖动边界
 *
 * 说明：注入 fake sleep 消除真实等待，单测秒级完成。
 */

import { describe, expect, test } from "bun:test";
import { APIError } from "@anthropic-ai/sdk";
import { AbortError } from "../../errors/index.ts";
import { LLMApiError } from "./errors.ts";
import {
  computeDelayMs,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  withRetry,
} from "./withRetry.ts";

/** Fake sleep：不实际等待，记录每次被调用的时长用于断言。 */
function makeFakeSleep(): {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    sleep: async (ms, signal) => {
      delays.push(ms);
      if (signal?.aborted) {
        // 模拟 default sleep 在中断时的"立即 resolve"语义
        return;
      }
    },
    delays,
  };
}

/** 构造一个带 status 的 LLMApiError，快速模拟可重试 5xx / 429。 */
function makeLLMApiError(status: number, message = "upstream"): LLMApiError {
  return new LLMApiError(message, { status });
}

/** 构造一个带 ECONNRESET code 的网络错误。 */
function makeNetworkError(code = "ECONNRESET"): Error & { code: string } {
  const err = new Error(`connect ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("withRetry", () => {
  test("首次成功 → 不重试，无 sleep", async () => {
    const { sleep, delays } = makeFakeSleep();
    const result = await withRetry(async () => 42, { sleep });
    expect(result).toBe(42);
    expect(delays.length).toBe(0);
  });

  test("可重试错误 2 次后成功 → 总共 3 次调用", async () => {
    const { sleep, delays } = makeFakeSleep();
    let attempts = 0;
    const result = await withRetry(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 3) throw makeLLMApiError(529);
        return "ok";
      },
      { sleep, maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays.length).toBe(2); // 第 1、2 次失败后各 sleep 一次
  });

  test("可重试错误耗尽 maxAttempts → 抛最后一次错误", async () => {
    const { sleep, delays } = makeFakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw makeLLMApiError(503, "upstream down");
        },
        { sleep, maxAttempts: 3, initialDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(LLMApiError);
    expect(calls).toBe(3);
    expect(delays.length).toBe(2); // 重试次数 = maxAttempts - 1
  });

  test("非可重试错误 → 立即抛，无 sleep", async () => {
    const { sleep, delays } = makeFakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw makeLLMApiError(400, "bad request");
        },
        { sleep, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(LLMApiError);
    expect(calls).toBe(1);
    expect(delays.length).toBe(0);
  });

  test("Abort 错误 → 永不重试", async () => {
    const { sleep, delays } = makeFakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new AbortError();
        },
        { sleep, maxAttempts: 5 },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
    expect(delays.length).toBe(0);
  });

  test("执行前 signal 已 abort → 抛 AbortError，不调用 fn", async () => {
    const { sleep } = makeFakeSleep();
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          return "never";
        },
        { sleep, signal: ctrl.signal },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(0);
  });

  test("网络错误 ECONNRESET → 可重试", async () => {
    const { sleep, delays } = makeFakeSleep();
    let calls = 0;
    const result = await withRetry(
      async (attempt) => {
        calls = attempt;
        if (attempt < 2) throw makeNetworkError("ECONNRESET");
        return "recovered";
      },
      { sleep, maxAttempts: 3, initialDelayMs: 5 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    expect(delays.length).toBe(1);
  });

  test("Retry-After 头存在 → delay 用服务端值，忽略指数退避", async () => {
    const { sleep, delays } = makeFakeSleep();
    // 构造一个 APIError-like 对象（含 headers.retry-after）作为 LLMApiError.cause
    const sdkErr = Object.create(APIError.prototype) as APIError;
    (sdkErr as { status: number }).status = 429;
    (sdkErr as { message: string }).message = "rate limit";
    const h = new Headers({ "retry-after": "2" }); // 2 秒
    (sdkErr as { headers: Headers }).headers = h;
    const wrapped = new LLMApiError("rate limit", { status: 429, cause: sdkErr });

    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw wrapped;
        },
        { sleep, maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(LLMApiError);
    expect(calls).toBe(2);
    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(2000);
  });
});

describe("computeDelayMs", () => {
  test("retryAfterMs 优先，跳过指数退避", () => {
    const d = computeDelayMs({
      attempt: 5,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      retryAfterMs: 250,
    });
    expect(d).toBe(250);
  });

  test("指数退避：attempt=1 → 约 initialDelayMs，允许 ±25% 抖动", () => {
    // 不使用 retryAfter，attempt=1 → base = 100 * 2^0 = 100，±25 抖动后 ∈ [75, 125]
    for (let i = 0; i < 30; i += 1) {
      const d = computeDelayMs({
        attempt: 1,
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        retryAfterMs: undefined,
      });
      expect(d).toBeGreaterThanOrEqual(75);
      expect(d).toBeLessThanOrEqual(125);
    }
  });

  test("延迟上限 maxDelayMs 生效（考虑 ±25% 抖动）", () => {
    // attempt=20 → 指数爆炸；应被 maxDelayMs 封顶
    for (let i = 0; i < 30; i += 1) {
      const d = computeDelayMs({
        attempt: 20,
        initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
        maxDelayMs: DEFAULT_MAX_DELAY_MS,
        retryAfterMs: undefined,
      });
      // 封顶后再抖动 ±25%，最大不超过 capped * 1.25
      expect(d).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS * 1.25 + 1);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });
});
