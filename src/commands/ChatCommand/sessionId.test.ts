/** sessionId 生成器单测。 */

import { describe, expect, test } from "bun:test";
import { generateSessionId, isUuidV4 } from "./sessionId.ts";

const FIXED_UUID = "3f4e2b70-8f4a-4d47-9e4f-2c3b7f7a8e10";

describe("generateSessionId", () => {
  test("默认生成 UUID v4（对齐 claude-code）", () => {
    const id = generateSessionId();

    expect(isUuidV4(id)).toBe(true);
    expect(id).toHaveLength(36);
  });

  test("可注入 UUID 生成器，便于确定性测试", () => {
    const id = generateSessionId(() => FIXED_UUID);

    expect(id).toBe(FIXED_UUID);
  });

  test("注入生成器返回非 UUID v4 时立即失败", () => {
    expect(() => generateSessionId(() => "2026-05-04T10-00-00-deadbeef")).toThrow(/UUID v4/);
  });
});

describe("isUuidV4", () => {
  test("接受 canonical lower-case UUID v4", () => {
    expect(isUuidV4(FIXED_UUID)).toBe(true);
  });

  test("拒绝非 v4 UUID 或历史 timestamp sessionId", () => {
    expect(isUuidV4("3f4e2b70-8f4a-5d47-9e4f-2c3b7f7a8e10")).toBe(false);
    expect(isUuidV4("2026-05-04T10-00-00-deadbeef")).toBe(false);
  });
});
