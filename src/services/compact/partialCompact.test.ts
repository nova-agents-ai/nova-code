import { describe, expect, test } from "bun:test";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages";
import { MessageRoleEnum, type NovaMessage } from "../../types/message.ts";
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES } from "./compact.ts";
import { partialCompactConversation } from "./partialCompact.ts";

// 与 compact.test.ts 同样的 fake Anthropic 客户端工厂
function makeFakeClient(text: string, recorded: { body: unknown }[]) {
  const final: SdkMessage = {
    id: "msg_partial_01",
    type: "message",
    role: "assistant",
    model: "fake-model",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text, citations: null }],
    usage: {
      input_tokens: 500,
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
      // biome-ignore lint/suspicious/noExplicitAny: fake
      stream: (body: any) => {
        recorded.push({ body });
        return {
          [Symbol.asyncIterator]() {
            return { next: async () => ({ done: true, value: undefined }) };
          },
          finalMessage: async () => final,
        };
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: cast
  } as any;
}

/** 构造 7 轮对话：每轮 = user(string) + assistant(text)。 */
function makeMessages(rounds: number): NovaMessage[] {
  const out: NovaMessage[] = [];
  for (let i = 0; i < rounds; i += 1) {
    out.push({ role: MessageRoleEnum.USER, content: `q${i}` });
    out.push({
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: `a${i}` }],
    });
  }
  return out;
}

const validSummary = "<analysis>x</analysis><summary>kept earlier work</summary>";

describe("partialCompactConversation", () => {
  test("不足 keepRecent + 1 轮 → 抛 NOT_ENOUGH_MESSAGES", async () => {
    const recorded: { body: unknown }[] = [];
    const client = makeFakeClient(validSummary, recorded);
    // 5 轮 == keepRecent，没有 prefix 可以压缩
    await expect(
      partialCompactConversation({
        messages: makeMessages(5),
        client,
        model: "fake-model",
        trigger: "auto",
        keepRecent: 5,
      }),
    ).rejects.toThrow(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
    expect(recorded.length).toBe(0);
  });

  test("超过 keepRecent + 1 轮 → 切片 + 压缩 prefix + 保留 tail", async () => {
    const recorded: { body: unknown }[] = [];
    const client = makeFakeClient(validSummary, recorded);
    const messages = makeMessages(7); // 7 用户输入；keepRecent=5 → prefix 含 q0/q1
    const result = await partialCompactConversation({
      messages,
      client,
      model: "fake-model",
      trigger: "manual",
      keepRecent: 5,
    });

    // splitIndex 应指向 q2 的下标（即 7 - 5 = 2 个用户输入之后的位置）
    // 每轮 2 条，q2 在数组下标 4
    expect(result.splitIndex).toBe(4);
    expect(result.keptMessages.length).toBe(messages.length - 4);

    // 第一条 keptMessages 必是 user 文本 q2
    const first = result.keptMessages[0];
    expect(first?.role).toBe(MessageRoleEnum.USER);
    expect(first?.content).toBe("q2");

    // summaryMessage 是 user 文本，含 Summary: header
    expect(result.summaryMessage.role).toBe(MessageRoleEnum.USER);
    if (typeof result.summaryMessage.content === "string") {
      expect(result.summaryMessage.content).toContain("Summary:");
      // partialCompact recentMessagesPreserved=true → 含相应提示
      expect(result.summaryMessage.content).toContain("Recent messages are preserved verbatim.");
    }
  });

  test("LLM 请求只看到 prefix + summary 指令；keptMessages 不在请求里", async () => {
    const recorded: { body: unknown }[] = [];
    const client = makeFakeClient(validSummary, recorded);
    const messages = makeMessages(7);
    await partialCompactConversation({
      messages,
      client,
      model: "fake-model",
      trigger: "auto",
      keepRecent: 5,
    });

    expect(recorded.length).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: snapshot inspection
    const body = recorded[0]?.body as any;
    // prefix 是 4 条 + 1 条 summary 指令 = 5
    expect(body.messages.length).toBe(5);
    // 最后一条是 user 文本，含压缩指令
    expect(body.messages.at(-1).role).toBe("user");
    expect(body.messages.at(-1).content).toContain("RECENT portion of the conversation");
  });

  test("keepRecent 默认值 = 5", async () => {
    const recorded: { body: unknown }[] = [];
    const client = makeFakeClient(validSummary, recorded);
    const messages = makeMessages(7);
    const result = await partialCompactConversation({
      messages,
      client,
      model: "fake-model",
      trigger: "auto",
    });
    // 7 用户输入 - 5 keepRecent = 2 prefix 用户输入；splitIndex 仍是 q2 的下标 = 4
    expect(result.splitIndex).toBe(4);
  });

  test("keepRecent < 1 抛错", async () => {
    const recorded: { body: unknown }[] = [];
    const client = makeFakeClient(validSummary, recorded);
    await expect(
      partialCompactConversation({
        messages: makeMessages(7),
        client,
        model: "fake-model",
        trigger: "auto",
        keepRecent: 0,
      }),
    ).rejects.toThrow();
  });
});
