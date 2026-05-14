import { describe, expect, test } from "bun:test";
import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
  getPartialCompactPrompt,
} from "./prompt.ts";

describe("getCompactPrompt", () => {
  test("不带 customInstructions 时含 NO_TOOLS_PREAMBLE 与 BASE 主体", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("CRITICAL: Respond with TEXT ONLY.");
    expect(prompt).toContain("Primary Request and Intent");
    expect(prompt).toContain("REMINDER: Do NOT call any tools.");
  });

  test("带 customInstructions 时把指令拼到末尾", () => {
    const prompt = getCompactPrompt("focus on test files");
    expect(prompt).toContain("Additional Instructions:\nfocus on test files");
  });

  test("空白字符串的 customInstructions 视为不传", () => {
    const prompt = getCompactPrompt("   ");
    expect(prompt).not.toContain("Additional Instructions:");
  });
});

describe("getPartialCompactPrompt", () => {
  test("使用 PARTIAL_COMPACT_PROMPT 的提示语", () => {
    const prompt = getPartialCompactPrompt();
    expect(prompt).toContain("RECENT portion of the conversation");
    expect(prompt).toContain("CRITICAL: Respond with TEXT ONLY.");
  });
});

describe("formatCompactSummary", () => {
  test("strip <analysis> 段", () => {
    const raw = `<analysis>
my draft thoughts
</analysis>
<summary>
clean output
</summary>`;
    const formatted = formatCompactSummary(raw);
    expect(formatted).not.toContain("<analysis>");
    expect(formatted).not.toContain("my draft thoughts");
  });

  test("把 <summary> 替换成 Summary: header", () => {
    const raw = "<summary>\n  important content\n</summary>";
    const formatted = formatCompactSummary(raw);
    expect(formatted).toContain("Summary:");
    expect(formatted).toContain("important content");
    expect(formatted).not.toContain("<summary>");
  });

  test("多重空行被折叠", () => {
    const raw = "<summary>line1\n\n\n\nline2</summary>";
    const formatted = formatCompactSummary(raw);
    // 折叠后是 \n\n
    expect(formatted).not.toMatch(/\n{3,}/);
  });

  test("没有 summary 标签时不爆但也不变形", () => {
    const raw = "just some plain text";
    expect(formatCompactSummary(raw)).toBe("just some plain text");
  });
});

describe("getCompactUserSummaryMessage", () => {
  const sampleSummary = "<summary>covered everything important</summary>";

  test("auto 触发（suppress=true）追加 Continue 段落", () => {
    const msg = getCompactUserSummaryMessage(sampleSummary, true, false);
    expect(msg).toContain("Continue the conversation from where it left off");
    expect(msg).toContain("Summary:");
  });

  test("手动触发（suppress=false）不追加 Continue 段落", () => {
    const msg = getCompactUserSummaryMessage(sampleSummary, false, false);
    expect(msg).not.toContain("Continue the conversation from where it left off");
  });

  test("partialCompact 模式（recentMessagesPreserved=true）追加提示", () => {
    const msg = getCompactUserSummaryMessage(sampleSummary, false, true);
    expect(msg).toContain("Recent messages are preserved verbatim.");
  });

  test("base 段固定提示 session 已 run out of context", () => {
    const msg = getCompactUserSummaryMessage(sampleSummary, false, false);
    expect(msg).toContain("This session is being continued");
    expect(msg).toContain("ran out of context");
  });
});
