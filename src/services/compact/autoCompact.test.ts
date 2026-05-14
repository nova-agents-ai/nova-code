import { describe, expect, test } from "bun:test";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages";
import { MessageRoleEnum, type NovaMessage } from "../../types/message.ts";
import {
  autoCompactIfNeeded,
  calculateTokenWarningState,
  createAutoCompactTrackingState,
  getRemainingTokensUntilAutoCompact,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  shouldAutoCompact,
} from "./autoCompact.ts";
import { getAutoCompactThreshold } from "./contextWindow.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fake Anthropic
// ────────────────────────────────────────────────────────────────────────────

function makeFakeClient(opts: { text?: string; throwOnFinal?: Error }) {
  const final: SdkMessage = {
    id: "msg_ac_01",
    type: "message",
    role: "assistant",
    model: "fake",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text: opts.text ?? "<summary>ok</summary>", citations: null }],
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
    },
    container: null,
    stop_details: null,
  };
  return {
    messages: {
      stream: () => ({
        [Symbol.asyncIterator]() {
          return { next: async () => ({ done: true, value: undefined }) };
        },
        finalMessage: async () => {
          if (opts.throwOnFinal) throw opts.throwOnFinal;
          return final;
        },
      }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: cast to Anthropic
  } as any;
}

// ────────────────────────────────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────────────────────────────────

const model = "claude-sonnet-4-5";

describe("calculateTokenWarningState", () => {
  test("阈值之下", () => {
    const state = calculateTokenWarningState(1000, model);
    expect(state.isAboveAutoCompactThreshold).toBe(false);
    expect(state.percentLeft).toBeGreaterThan(90);
  });

  test("阈值之上", () => {
    const threshold = getAutoCompactThreshold(model);
    const state = calculateTokenWarningState(threshold + 1, model);
    expect(state.isAboveAutoCompactThreshold).toBe(true);
    expect(state.percentLeft).toBe(0);
  });
});

/**
 * 构造一组"末尾带超阈值 usage" 的 messages —— claude-code 同款 walk-back-from-end
 * 算法会把这条 usage 的 total 作为 token 锚点。
 */
function aboveThresholdMessages(): NovaMessage[] {
  const threshold = getAutoCompactThreshold(model);
  return [
    { role: MessageRoleEnum.USER, content: "hello" },
    {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: threshold + 100, output_tokens: 0 },
    },
  ];
}

describe("shouldAutoCompact", () => {
  test("disabled → false", () => {
    expect(
      shouldAutoCompact({
        messages: [{ role: MessageRoleEnum.USER, content: "hi" }],
        model,
        enabled: false,
      }),
    ).toBe(false);
  });

  test("空 messages → false", () => {
    expect(shouldAutoCompact({ messages: [], model, enabled: true })).toBe(false);
  });

  test("token 估算 < 阈值 → false", () => {
    expect(
      shouldAutoCompact({
        messages: [{ role: MessageRoleEnum.USER, content: "short" }],
        model,
        enabled: true,
      }),
    ).toBe(false);
  });

  test("末尾 assistant.usage 超阈值 → true", () => {
    expect(
      shouldAutoCompact({
        messages: aboveThresholdMessages(),
        model,
        enabled: true,
      }),
    ).toBe(true);
  });
});

describe("autoCompactIfNeeded", () => {
  test("disabled → no-op", async () => {
    const tracking = createAutoCompactTrackingState();
    const result = await autoCompactIfNeeded({
      messages: [{ role: MessageRoleEnum.USER, content: "hi" }],
      client: makeFakeClient({}),
      model,
      tracking,
      enabled: false,
    });
    expect(result.wasCompacted).toBe(false);
  });

  test("circuit breaker 已触发 → no-op，不调 LLM", async () => {
    const tracking = createAutoCompactTrackingState();
    tracking.consecutiveFailures = MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
    const result = await autoCompactIfNeeded({
      messages: aboveThresholdMessages(),
      client: makeFakeClient({}),
      model,
      tracking,
      enabled: true,
    });
    expect(result.wasCompacted).toBe(false);
  });

  test("阈值之下 → no-op", async () => {
    const tracking = createAutoCompactTrackingState();
    const result = await autoCompactIfNeeded({
      messages: [{ role: MessageRoleEnum.USER, content: "small" }],
      client: makeFakeClient({}),
      model,
      tracking,
      enabled: true,
    });
    expect(result.wasCompacted).toBe(false);
    expect(tracking.consecutiveFailures).toBe(0);
  });

  test("超阈值 + 成功 → 重置 tracking + 返回 summaryMessage", async () => {
    const tracking = createAutoCompactTrackingState();
    tracking.consecutiveFailures = 1; // 之前失败一次

    const result = await autoCompactIfNeeded({
      messages: aboveThresholdMessages(),
      client: makeFakeClient({}),
      model,
      tracking,
      enabled: true,
    });

    expect(result.wasCompacted).toBe(true);
    expect(result.summaryMessage).toBeDefined();
    expect(tracking.compacted).toBe(true);
    expect(tracking.consecutiveFailures).toBe(0);
  });

  test("超阈值 + 失败 → 不抛错，consecutiveFailures+1", async () => {
    const tracking = createAutoCompactTrackingState();
    const result = await autoCompactIfNeeded({
      messages: aboveThresholdMessages(),
      client: makeFakeClient({ throwOnFinal: new Error("boom") }),
      model,
      tracking,
      enabled: true,
    });

    expect(result.wasCompacted).toBe(false);
    expect(result.error).toContain("boom");
    expect(tracking.consecutiveFailures).toBe(1);
  });

  test("3 次失败后第 4 次自动跳过（不再调 LLM）", async () => {
    const tracking = createAutoCompactTrackingState();
    const failingClient = makeFakeClient({ throwOnFinal: new Error("boom") });
    const okClient = makeFakeClient({});

    for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i += 1) {
      await autoCompactIfNeeded({
        messages: aboveThresholdMessages(),
        client: failingClient,
        model,
        tracking,
        enabled: true,
      });
    }
    expect(tracking.consecutiveFailures).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);

    const result = await autoCompactIfNeeded({
      messages: aboveThresholdMessages(),
      client: okClient,
      model,
      tracking,
      enabled: true,
    });
    expect(result.wasCompacted).toBe(false);
  });

  test("forked-agent: systemPrompt + sdkTools 透传到 LLM 请求", async () => {
    const tracking = createAutoCompactTrackingState();
    let capturedBody: { system?: unknown; tools?: unknown; tool_choice?: unknown } = {};
    const client = {
      messages: {
        // biome-ignore lint/suspicious/noExplicitAny: spy
        stream: (body: any) => {
          capturedBody = body;
          const final = makeFakeClient({}).messages.stream(body);
          return final;
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: cast
    } as any;

    await autoCompactIfNeeded({
      messages: aboveThresholdMessages(),
      client,
      model,
      tracking,
      enabled: true,
      systemPrompt: "I AM SYSTEM",
      sdkTools: [{ name: "fake_tool", input_schema: { type: "object" } }],
    });

    expect(capturedBody.system).toBe("I AM SYSTEM");
    expect(Array.isArray(capturedBody.tools)).toBe(true);
    expect(capturedBody.tool_choice).toEqual({ type: "none" });
  });
});

describe("getRemainingTokensUntilAutoCompact", () => {
  test("低用量时返回大数", () => {
    expect(getRemainingTokensUntilAutoCompact([], model)).toBeGreaterThan(100_000);
  });

  test("超阈值时返回 0", () => {
    expect(getRemainingTokensUntilAutoCompact(aboveThresholdMessages(), model)).toBe(0);
  });
});
