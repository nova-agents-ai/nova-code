/**
 * compactConversation 主路径单测。
 *
 * 用 hand-rolled fake Anthropic client 替代真实 SDK：mockClient 已经够用，
 * 但它的 scenario 是按 LLM 请求形态（含 tools / messages）路由的；compact
 * 路径里我们更想直接控制响应。所以用本地 fake，更简单。
 */

import { describe, expect, test } from "bun:test";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages";
import { MessageRoleEnum, type NovaMessage } from "../../types/message.ts";
import {
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
} from "./compact.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fake Anthropic Client：对外只暴露 messages.stream 接口
// ────────────────────────────────────────────────────────────────────────────

interface FakeStreamResult {
  readonly text: string;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
  readonly throwOnStream?: Error;
  readonly throwOnFinal?: Error;
}

interface RecordedRequest {
  // biome-ignore lint/suspicious/noExplicitAny: SDK 请求体的 body 形态多变，测试断言只挑字段
  readonly body: any;
}

function makeFakeClient(result: FakeStreamResult, recorded: RecordedRequest[]) {
  const final: SdkMessage = {
    id: "msg_fake_01",
    type: "message",
    role: "assistant",
    model: "fake-model",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text: result.text, citations: null }],
    usage: {
      input_tokens: result.usage?.input_tokens ?? 1000,
      output_tokens: result.usage?.output_tokens ?? 200,
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
      // biome-ignore lint/suspicious/noExplicitAny: fake SDK
      stream: (body: any) => {
        recorded.push({ body });
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                if (result.throwOnStream) throw result.throwOnStream;
                return { done: true, value: undefined };
              },
            };
          },
          finalMessage: async () => {
            if (result.throwOnFinal) throw result.throwOnFinal;
            return final;
          },
        };
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: cast to Anthropic at call site
  } as any;
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const sampleMessages: NovaMessage[] = [
  { role: MessageRoleEnum.USER, content: "fix bug X" },
  { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "looking..." }] },
  { role: MessageRoleEnum.USER, content: "here's the file" },
  { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "patched" }] },
];

const validSummaryText =
  "<analysis>thoughts</analysis><summary>fixed bug X by patching foo.ts</summary>";

// ────────────────────────────────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────────────────────────────────

describe("compactConversation", () => {
  test("空 messages → ERROR_MESSAGE_NOT_ENOUGH_MESSAGES", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: "irrelevant" }, recorded);
    await expect(
      compactConversation({
        messages: [],
        client,
        model: "fake-model",
        trigger: "auto",
      }),
    ).rejects.toThrow(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
    // 不该走到 LLM 调用
    expect(recorded.length).toBe(0);
  });

  test("成功路径：返回 summaryMessage + 估算前后 token", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient(
      { text: validSummaryText, usage: { input_tokens: 1000, output_tokens: 200 } },
      recorded,
    );
    const result = await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "auto",
    });

    expect(result.rawSummaryText).toBe(validSummaryText);
    expect(result.summaryMessage.role).toBe(MessageRoleEnum.USER);
    expect(typeof result.summaryMessage.content).toBe("string");
    if (typeof result.summaryMessage.content === "string") {
      expect(result.summaryMessage.content).toContain("Summary:");
      expect(result.summaryMessage.content).toContain("fixed bug X");
      // auto trigger → 应包含 Continue 段落
      expect(result.summaryMessage.content).toContain("Continue the conversation");
    }
    expect(result.preCompactTokenCount).toBeGreaterThan(0);
    expect(result.postCompactTokenCount).toBeGreaterThan(0);
    expect(result.compactionUsage.input_tokens).toBe(1000);
    expect(result.compactionUsage.output_tokens).toBe(200);
  });

  test("manual trigger → summary 不含 Continue 段落", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: validSummaryText }, recorded);
    const result = await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "manual",
    });
    if (typeof result.summaryMessage.content === "string") {
      expect(result.summaryMessage.content).not.toContain("Continue the conversation");
    }
  });

  test("自定义 instructions 进入 LLM 请求的尾部 user message", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: validSummaryText }, recorded);
    await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "manual",
      customInstructions: "focus on Bash command edits",
    });

    expect(recorded.length).toBe(1);
    const lastMsg = recorded[0]?.body.messages.at(-1);
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("Additional Instructions:");
    expect(lastMsg.content).toContain("focus on Bash command edits");
  });

  test("空文本响应 → ERROR_MESSAGE_INCOMPLETE_RESPONSE", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: "   " }, recorded);
    await expect(
      compactConversation({
        messages: sampleMessages,
        client,
        model: "fake-model",
        trigger: "auto",
      }),
    ).rejects.toThrow(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
  });

  test("APIUserAbortError 原样上抛", async () => {
    const recorded: RecordedRequest[] = [];
    const abortError = new APIUserAbortError();
    const client = makeFakeClient({ text: "x", throwOnFinal: abortError }, recorded);
    await expect(
      compactConversation({
        messages: sampleMessages,
        client,
        model: "fake-model",
        trigger: "manual",
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
  });

  test("未注入 sdkTools 时不带 tools 字段", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: validSummaryText }, recorded);
    await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "auto",
    });
    expect(recorded[0]?.body.tools).toBeUndefined();
  });

  test("forked-agent 模式：复用 system/tools 且 tool_choice=none", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: validSummaryText }, recorded);
    await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "auto",
      systemPrompt: "same system",
      sdkTools: [
        {
          name: "Bash",
          description: "run shell command",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    expect(recorded[0]?.body.system).toBe("same system");
    expect(recorded[0]?.body.tools).toHaveLength(1);
    expect(recorded[0]?.body.tool_choice).toEqual({ type: "none" });
  });

  test("max_tokens 走 MAX_OUTPUT_TOKENS_FOR_SUMMARY (20K)", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: validSummaryText }, recorded);
    await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "auto",
    });
    expect(recorded[0]?.body.max_tokens).toBe(20_000);
  });

  test("写 LLM log sink：compact_request + compact_response", async () => {
    const recorded: RecordedRequest[] = [];
    const client = makeFakeClient({ text: validSummaryText }, recorded);
    const logEntries: unknown[] = [];
    const sink = { write: (p: unknown) => logEntries.push(p) };
    await compactConversation({
      messages: sampleMessages,
      client,
      model: "fake-model",
      trigger: "auto",
      llmLogSink: sink,
    });
    expect(logEntries.length).toBe(2);
    expect((logEntries[0] as { kind: string }).kind).toBe("compact_request");
    expect((logEntries[1] as { kind: string }).kind).toBe("compact_response");
  });
});
