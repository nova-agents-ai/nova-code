import { describe, expect, test } from "bun:test";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getAutoCompactThreshold,
  getContextWindowForModel,
  getEffectiveContextWindowSize,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  MODEL_CONTEXT_WINDOW_DEFAULT,
} from "./contextWindow.ts";

describe("getContextWindowForModel", () => {
  test("claude 模型返回 200K", () => {
    expect(getContextWindowForModel("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(getContextWindowForModel("claude-opus-4-7")).toBe(200_000);
    expect(getContextWindowForModel("claude-haiku-4-5")).toBe(200_000);
  });

  test("未知模型回落到默认 200K", () => {
    expect(getContextWindowForModel("gpt-4")).toBe(MODEL_CONTEXT_WINDOW_DEFAULT);
  });
});

describe("getEffectiveContextWindowSize", () => {
  test("等于总窗口减去预留 summary 输出", () => {
    expect(getEffectiveContextWindowSize("claude-sonnet-4-5")).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT - MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    );
  });
});

describe("getAutoCompactThreshold", () => {
  test("等于有效窗口再减 AUTOCOMPACT_BUFFER", () => {
    const expected =
      MODEL_CONTEXT_WINDOW_DEFAULT - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;
    expect(getAutoCompactThreshold("claude-sonnet-4-5")).toBe(expected);
    expect(expected).toBe(167_000);
  });
});
