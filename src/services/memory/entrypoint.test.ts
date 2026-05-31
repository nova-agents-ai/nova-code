import { describe, expect, test } from "bun:test";
import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from "./entrypoint.ts";

describe("truncateEntrypointContent", () => {
  test("小内容原样返回（trim）", () => {
    const result = truncateEntrypointContent("  hello\n");
    expect(result.content).toBe("hello");
    expect(result.wasLineTruncated).toBe(false);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.lineCount).toBe(1);
  });

  test("超 200 行按行截断 + warning", () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 50 }, (_, i) => `- line ${i}`);
    const result = truncateEntrypointContent(lines.join("\n"));
    expect(result.wasLineTruncated).toBe(true);
    expect(result.wasByteTruncated).toBe(false);
    expect(result.lineCount).toBe(MAX_ENTRYPOINT_LINES + 50);
    expect(result.content).toContain(`WARNING: MEMORY.md is ${MAX_ENTRYPOINT_LINES + 50} lines`);
    // 保留前 MAX_ENTRYPOINT_LINES 行
    expect(result.content).toContain(`- line ${MAX_ENTRYPOINT_LINES - 1}`);
    expect(result.content).not.toContain(`- line ${MAX_ENTRYPOINT_LINES}`);
  });

  test("超 25KB 单行按字节截断 + warning", () => {
    const longLine = "x".repeat(MAX_ENTRYPOINT_BYTES + 100);
    const result = truncateEntrypointContent(longLine);
    expect(result.wasByteTruncated).toBe(true);
    expect(result.wasLineTruncated).toBe(false);
    expect(result.content).toContain("index entries are too long");
    // 截断后内容（去掉 warning 段）<= MAX_ENTRYPOINT_BYTES
    const bodyOnly = result.content.split("\n\n> WARNING")[0] ?? "";
    expect(bodyOnly.length).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES);
  });

  test("双门同时命中 → 文案同时报 lines + bytes", () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 10 }, () => "x".repeat(500));
    const result = truncateEntrypointContent(lines.join("\n"));
    expect(result.wasLineTruncated).toBe(true);
    expect(result.wasByteTruncated).toBe(true);
    expect(result.content).toContain("lines and");
  });
});
