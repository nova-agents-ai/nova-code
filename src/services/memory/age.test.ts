import { describe, expect, test } from "bun:test";
import { memoryAge, memoryAgeDays, memoryFreshnessText } from "./age.ts";

const MS_PER_DAY = 86_400_000;

describe("memoryAgeDays", () => {
  test("今天 → 0", () => {
    expect(memoryAgeDays(Date.now())).toBe(0);
  });

  test("昨天 → 1", () => {
    expect(memoryAgeDays(Date.now() - MS_PER_DAY)).toBe(1);
  });

  test("47 天前 → 47", () => {
    expect(memoryAgeDays(Date.now() - 47 * MS_PER_DAY)).toBe(47);
  });

  test("时钟漂移：未来 mtime → 0（夹住）", () => {
    expect(memoryAgeDays(Date.now() + 10_000)).toBe(0);
  });
});

describe("memoryAge", () => {
  test("0 天 → today", () => {
    expect(memoryAge(Date.now())).toBe("today");
  });

  test("1 天 → yesterday", () => {
    expect(memoryAge(Date.now() - MS_PER_DAY)).toBe("yesterday");
  });

  test("47 天 → 47 days ago", () => {
    expect(memoryAge(Date.now() - 47 * MS_PER_DAY)).toBe("47 days ago");
  });
});

describe("memoryFreshnessText", () => {
  test("≤ 1 天返回空（不噪声）", () => {
    expect(memoryFreshnessText(Date.now())).toBe("");
    expect(memoryFreshnessText(Date.now() - MS_PER_DAY)).toBe("");
  });

  test("> 1 天含天数 + 验证告诫", () => {
    const text = memoryFreshnessText(Date.now() - 47 * MS_PER_DAY);
    expect(text).toContain("47 days old");
    expect(text).toContain("Verify against current code");
  });
});
