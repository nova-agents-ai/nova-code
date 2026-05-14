/**
 * 默认 AnalyticsSink 实现单测（sink.ts）。
 *
 * 重点验证：
 *   1. ringBuffer：插入顺序 + 环形覆盖
 *   2. NOVA_DISABLE_TELEMETRY → noop sink，buffer 永远为空
 *   3. 文件落盘：JSONL append + 串行化（无 race 丢条）
 *   4. logEventAsync await 时已落盘
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultAnalyticsSink } from "./sink.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "nova-sink-"));
  delete process.env["NOVA_DISABLE_TELEMETRY"];
  delete process.env["NOVA_TELEMETRY_FILE"];
});

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("ringBuffer", () => {
  test("插入顺序保留", () => {
    const sink = createDefaultAnalyticsSink();
    sink.logEvent("tengu_a", { i: 0 });
    sink.logEvent("tengu_b", { i: 1 });
    const buf = sink.getBuffer();
    expect(buf.length).toBe(2);
    expect(buf[0]?.name).toBe("tengu_a");
    expect(buf[1]?.name).toBe("tengu_b");
  });

  test("payload 原样保留", () => {
    const sink = createDefaultAnalyticsSink();
    sink.logEvent("tengu_x", { count: 3, ok: true, label: "foo" });
    expect(sink.getBuffer()[0]?.payload).toEqual({ count: 3, ok: true, label: "foo" });
  });

  test("timestamp 是合法 ISO", () => {
    const sink = createDefaultAnalyticsSink();
    sink.logEvent("tengu_x");
    const ts = sink.getBuffer()[0]?.timestamp ?? "";
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });

  test("超容量环形覆盖", () => {
    const sink = createDefaultAnalyticsSink({ capacity: 5 });
    for (let i = 0; i < 8; i += 1) sink.logEvent("tengu_x", { i });
    const buf = sink.getBuffer();
    expect(buf.length).toBe(5);
    expect((buf[0]?.payload as { i: number }).i).toBe(3);
    expect((buf.at(-1)?.payload as { i: number }).i).toBe(7);
  });
});

describe("NOVA_DISABLE_TELEMETRY", () => {
  test("disabled=true → noop sink，buffer 始终为空", () => {
    const sink = createDefaultAnalyticsSink({ disabled: true });
    sink.logEvent("tengu_x");
    expect(sink.getBuffer()).toEqual([]);
  });

  test("env NOVA_DISABLE_TELEMETRY=1 → noop", () => {
    process.env["NOVA_DISABLE_TELEMETRY"] = "1";
    const sink = createDefaultAnalyticsSink();
    sink.logEvent("tengu_x");
    expect(sink.getBuffer()).toEqual([]);
  });

  test("env NOVA_DISABLE_TELEMETRY=true → noop", () => {
    process.env["NOVA_DISABLE_TELEMETRY"] = "true";
    const sink = createDefaultAnalyticsSink();
    sink.logEvent("tengu_x");
    expect(sink.getBuffer()).toEqual([]);
  });
});

describe("JSONL 落盘", () => {
  test("logEvent 同步路径 + 多条不丢（promise 链串行化）", async () => {
    const filePath = join(tmp, "events.jsonl");
    const sink = createDefaultAnalyticsSink({ telemetryFile: filePath });
    sink.logEvent("tengu_a", { i: 1 });
    sink.logEvent("tengu_b", { i: 2 });
    sink.logEvent("tengu_c", { i: 3 });
    // 同步路径不 await；用 logEventAsync 的 await 等链耗尽
    await sink.logEventAsync("tengu_flush");

    const text = await Bun.file(filePath).text();
    const lines = text.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0] ?? "{}").name).toBe("tengu_a");
    expect(JSON.parse(lines[1] ?? "{}").name).toBe("tengu_b");
    expect(JSON.parse(lines[2] ?? "{}").name).toBe("tengu_c");
    expect(JSON.parse(lines[3] ?? "{}").name).toBe("tengu_flush");
  });

  test("logEventAsync await 后该事件已落盘", async () => {
    const filePath = join(tmp, "events.jsonl");
    const sink = createDefaultAnalyticsSink({ telemetryFile: filePath });
    await sink.logEventAsync("tengu_async", { v: 42 });
    const text = await Bun.file(filePath).text();
    expect(text.trim()).toContain('"name":"tengu_async"');
  });

  test("未配置 telemetryFile 时不创建文件", async () => {
    const sink = createDefaultAnalyticsSink();
    sink.logEvent("tengu_x");
    await sink.logEventAsync("tengu_x2");
    // tmp 目录下应无文件
    const exists = await Bun.file(join(tmp, "events.jsonl")).exists();
    expect(exists).toBe(false);
  });
});
