import { describe, expect, test } from "bun:test";
import { MessageRoleEnum, type NovaMessage } from "../../types/message.ts";
import {
  type ApiUsage,
  getTokenCountFromUsage,
  roughTokenCountEstimationForMessages,
  tokenCountWithEstimation,
} from "./tokens.ts";

describe("getTokenCountFromUsage", () => {
  test("input + output", () => {
    const usage: ApiUsage = { input_tokens: 100, output_tokens: 50 };
    expect(getTokenCountFromUsage(usage)).toBe(150);
  });

  test("含 cache 字段时一并相加", () => {
    const usage: ApiUsage = {
      input_tokens: 100,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 20,
      output_tokens: 50,
    };
    expect(getTokenCountFromUsage(usage)).toBe(200);
  });

  test("cache 字段为 null 视作 0", () => {
    const usage: ApiUsage = {
      input_tokens: 100,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: 50,
    };
    expect(getTokenCountFromUsage(usage)).toBe(150);
  });
});

describe("roughTokenCountEstimationForMessages", () => {
  test("空数组返回 0", () => {
    expect(roughTokenCountEstimationForMessages([])).toBe(0);
  });

  test("纯字符串 content 按 length/4 估算", () => {
    const msg: NovaMessage = { role: MessageRoleEnum.USER, content: "a".repeat(40) };
    // 40 / 4 = 10
    expect(roughTokenCountEstimationForMessages([msg])).toBe(10);
  });

  test("text block 按文本长度估算", () => {
    const msg: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "hello world!!" }], // 13 字符
    };
    // ceil(13/4) = 4
    expect(roughTokenCountEstimationForMessages([msg])).toBe(4);
  });

  test("tool_use 按 JSON.stringify(input).length + name.length 估算", () => {
    const msg: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [
        {
          type: "tool_use",
          id: "x",
          name: "Bash", // 4
          input: { command: "ls" }, // {"command":"ls"} = 16
        },
      ],
    };
    // ceil((16 + 4) / 4) = 5
    expect(roughTokenCountEstimationForMessages([msg])).toBe(5);
  });

  test("tool_result 按 content.length 估算", () => {
    const msg: NovaMessage = {
      role: MessageRoleEnum.USER,
      content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
    };
    // ceil(2/4) = 1
    expect(roughTokenCountEstimationForMessages([msg])).toBe(1);
  });

  test("多条 message 累加", () => {
    const msgs: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "a".repeat(40) }, // 10
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "b".repeat(20) }] }, // 5
    ];
    expect(roughTokenCountEstimationForMessages(msgs)).toBe(15);
  });
});

describe("tokenCountWithEstimation（walk-back-from-end）", () => {
  test("没有任何带 usage 的 message → 全量 chars/4 估算", () => {
    const msgs: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "a".repeat(40) },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "b".repeat(20) }] },
      { role: MessageRoleEnum.USER, content: "c".repeat(8) },
    ];
    // 10 + 5 + 2 = 17
    expect(tokenCountWithEstimation(msgs)).toBe(17);
  });

  test("有带 usage 的 assistant → 该消息 usage.total + 之后估算", () => {
    const msgs: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "a".repeat(40) },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "b".repeat(20) }],
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
      { role: MessageRoleEnum.USER, content: "c".repeat(8) },
    ];
    // 1000（usage）+ 2（c×8 / 4）= 1002
    expect(tokenCountWithEstimation(msgs)).toBe(1002);
  });

  test("usage 在末尾 → 直接返回 usage.total（之后无新 message）", () => {
    const msgs: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "a" },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "b" }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      },
    ];
    expect(tokenCountWithEstimation(msgs)).toBe(1050);
  });

  test("多条带 usage → 取最末那条", () => {
    const msgs: NovaMessage[] = [
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "old" }],
        usage: { input_tokens: 100, output_tokens: 0 },
      },
      { role: MessageRoleEnum.USER, content: "u" },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "new" }],
        usage: { input_tokens: 999, output_tokens: 0 },
      },
    ];
    // 取 999 那条；之后无新 message
    expect(tokenCountWithEstimation(msgs)).toBe(999);
  });

  test("usage 含 cache 字段时一并相加", () => {
    const msgs: NovaMessage[] = [
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "x" }],
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 25,
          output_tokens: 25,
        },
      },
    ];
    expect(tokenCountWithEstimation(msgs)).toBe(200);
  });
});
