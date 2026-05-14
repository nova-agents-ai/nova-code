/**
 * services/analytics 门面层（index.ts）单测。
 *
 * 重点验证 claude-code 同款两层架构语义：
 *   1. attach 前 logEvent / logEventAsync 入队
 *   2. attach 时 queueMicrotask 异步排空（不阻塞 attach 调用）
 *   3. attachAnalyticsSink 幂等
 *   4. sink 抛错被吞，门面层 logEvent 永不抛
 *
 * 默认 sink 的 ringBuffer / 文件落盘 / NOVA_DISABLE_TELEMETRY 等
 * 实现细节走 sink.test.ts。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _hasSinkForTests,
  _peekQueueSizeForTests,
  _resetAnalyticsForTests,
  type AnalyticsSink,
  attachAnalyticsSink,
  type LogEventPayload,
  logEvent,
  logEventAsync,
} from "./index.ts";

// 一个最小 spy sink：把所有 logEvent / logEventAsync 调用记下来
function makeSpySink(): AnalyticsSink & {
  readonly events: { name: string; payload: LogEventPayload; via: "sync" | "async" }[];
} {
  const events: { name: string; payload: LogEventPayload; via: "sync" | "async" }[] = [];
  return {
    events,
    logEvent: (name, payload = {}) => {
      events.push({ name, payload, via: "sync" });
    },
    logEventAsync: async (name, payload = {}) => {
      events.push({ name, payload, via: "async" });
    },
  };
}

beforeEach(() => {
  _resetAnalyticsForTests();
});

afterEach(() => {
  _resetAnalyticsForTests();
});

describe("门面层：attach 前 enqueue", () => {
  test("attach 前 logEvent 进队不立即投递", () => {
    expect(_hasSinkForTests()).toBe(false);
    logEvent("tengu_a");
    logEvent("tengu_b", { x: 1 });
    expect(_peekQueueSizeForTests()).toBe(2);
  });

  test("attach 前 logEventAsync 同样进队（async=true）", async () => {
    await logEventAsync("tengu_async", { y: true });
    expect(_peekQueueSizeForTests()).toBe(1);
  });
});

describe("attachAnalyticsSink", () => {
  test("attach 时 queue 被异步排空（不在同步路径完成）", async () => {
    logEvent("tengu_pre1");
    logEvent("tengu_pre2");
    expect(_peekQueueSizeForTests()).toBe(2);

    const spy = makeSpySink();
    attachAnalyticsSink(spy);

    // attach 调用同步返回时 queue 已清空，但 sink 还没收到（queueMicrotask 异步）
    expect(_peekQueueSizeForTests()).toBe(0);
    expect(spy.events.length).toBe(0);

    // microtask 跑完后才会到 sink
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(spy.events.map((e) => e.name)).toEqual(["tengu_pre1", "tengu_pre2"]);
  });

  test("attach 后 logEvent 直接路由到 sink，不再入队", () => {
    const spy = makeSpySink();
    attachAnalyticsSink(spy);
    logEvent("tengu_post", { z: "ok" });
    expect(_peekQueueSizeForTests()).toBe(0);
    expect(spy.events).toEqual([{ name: "tengu_post", payload: { z: "ok" }, via: "sync" }]);
  });

  test("attach 后 logEventAsync 走 async 路径", async () => {
    const spy = makeSpySink();
    attachAnalyticsSink(spy);
    await logEventAsync("tengu_async_post");
    expect(spy.events).toEqual([{ name: "tengu_async_post", payload: {}, via: "async" }]);
  });

  test("attach 幂等：重复调被忽略", async () => {
    const spy1 = makeSpySink();
    const spy2 = makeSpySink();
    attachAnalyticsSink(spy1);
    attachAnalyticsSink(spy2); // no-op
    logEvent("tengu_x");
    expect(spy1.events.length).toBe(1);
    expect(spy2.events.length).toBe(0);
  });

  test("queue 排空时区分 sync / async", async () => {
    logEvent("tengu_sync_one");
    await logEventAsync("tengu_async_one");
    const spy = makeSpySink();
    attachAnalyticsSink(spy);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    // 第一条以 sync 模式入队 → 走 sink.logEvent
    expect(spy.events[0]?.via).toBe("sync");
    // 第二条以 async 模式入队 → 走 sink.logEventAsync
    expect(spy.events[1]?.via).toBe("async");
  });
});

describe("永不抛", () => {
  test("sink.logEvent 抛错被吞", () => {
    attachAnalyticsSink({
      logEvent: () => {
        throw new Error("boom");
      },
      logEventAsync: async () => {},
    });
    expect(() => logEvent("tengu_x")).not.toThrow();
  });

  test("sink.logEventAsync reject 被 await 吸收", async () => {
    attachAnalyticsSink({
      logEvent: () => {},
      logEventAsync: async () => {
        throw new Error("boom");
      },
    });
    await expect(logEventAsync("tengu_x")).resolves.toBeUndefined();
  });

  test("attach 时排空 queue 期间 sink 抛错不影响后续事件", async () => {
    let count = 0;
    logEvent("tengu_a");
    logEvent("tengu_b");
    logEvent("tengu_c");
    attachAnalyticsSink({
      logEvent: () => {
        count += 1;
        if (count === 2) throw new Error("middle boom");
      },
      logEventAsync: async () => {},
    });
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    // 三条都被尝试投递；中间抛错不影响 a / c
    expect(count).toBe(3);
  });
});
