/**
 * sessionId 生成器单测。
 *
 * 用注入的 Date + 固定随机字节保证断言确定性。
 */

import { describe, expect, test } from "bun:test";
import { generateSessionId } from "./sessionId.ts";

describe("generateSessionId", () => {
  test("按 <ISO-YYYY-MM-DDTHH-mm-ss>-<hex8> 格式生成", () => {
    const now = new Date(2026, 4, 1, 15, 11, 23); // 月 0-indexed → 5 月
    const random = (size: number): Buffer => Buffer.alloc(size, 0xab); // ababab...
    const id = generateSessionId(now, random);
    expect(id).toBe("2026-05-01T15-11-23-abababab");
  });

  test("月/日/时/分/秒补零到两位", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const random = (size: number): Buffer => Buffer.alloc(size, 0x0f);
    const id = generateSessionId(now, random);
    expect(id).toBe("2026-01-02T03-04-05-0f0f0f0f");
  });

  test("字典序与时序一致（便于 ls -1 | tail 找最近会话）", () => {
    const random = (size: number): Buffer => Buffer.alloc(size, 0);
    const earlier = generateSessionId(new Date(2026, 4, 1, 10, 0, 0), random);
    const later = generateSessionId(new Date(2026, 4, 1, 10, 0, 1), random);
    expect(earlier < later).toBe(true);
  });

  test("不注入 random 时使用真随机；长度稳定（hex 8 字符）", () => {
    const now = new Date(2026, 4, 1, 15, 11, 23);
    const id = generateSessionId(now);
    // "2026-05-01T15-11-23-" 长度 20；再加 8 字符 hex → 28
    expect(id.length).toBe(28);
    expect(id.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
  });
});
