/**
 * ChatSession 单元测试。
 *
 * 核心校验：
 * 1. 多轮 sendTurn 后 snapshot 的 messages 按 user→assistant→tool_result_user→...
 *    顺序严格配对（与 QueryEngine 内部 messages 数组保持一致）
 * 2. clear 清空对话历史但保留 meta
 * 3. restore 能注入历史后继续 sendTurn（新消息追加在注入历史之后）
 * 4. sendTurn 中途抛错时 messages 不变（原子性保证）
 *
 * 手段：注入 fake runAgentLoop，按脚本吐事件。完全不碰真实 Anthropic SDK。
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedConfig } from "../../config/config.ts";
import type { runAgentLoop } from "../../QueryEngine.ts";
import {
  type AgentEvent,
  AgentStopReasonEnum,
  MessageRoleEnum,
  type NovaMessage,
} from "../../types/message.ts";
import { ChatSession, type ChatTurnContext, type SessionMeta } from "./ChatSession.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fake agent loop
// ────────────────────────────────────────────────────────────────────────────

/**
 * 构造一个 fake runAgentLoop：按 params 忽略 signal/tools，直接 yield 预设事件序列。
 * 若 events 数组里带特殊 { throw: Error } 哨兵，yield 到那里就抛。
 */
function makeFakeAgentLoop(
  events: readonly (AgentEvent | { readonly __throw: Error })[],
): typeof runAgentLoop {
  return async function* fakeAgentLoop(
    _params: unknown,
  ): AsyncGenerator<AgentEvent, NovaMessage, void> {
    let last: NovaMessage = { role: MessageRoleEnum.ASSISTANT, content: [] };
    for (const item of events) {
      if ("__throw" in item) {
        throw item.__throw;
      }
      if (item.type === "turn_end") {
        last = item.message;
      }
      yield item;
    }
    return last;
  } as unknown as typeof runAgentLoop;
}

// ────────────────────────────────────────────────────────────────────────────
// 通用 fixture
// ────────────────────────────────────────────────────────────────────────────

const FIXED_META: SessionMeta = {
  sessionId: "2026-05-04T10-00-00-deadbeef",
  model: "claude-test",
  createdAt: "2026-05-04T10:00:00.000Z",
};

const FIXED_CONFIG: ResolvedConfig = {
  apiKey: "sk-test",
  baseURL: undefined,
  model: "claude-test",
  maxTokens: 1024,
  maxTurns: 5,
  webProxy: undefined,
  webProxyDomains: [],
};

function makeCtx(agentLoop: typeof runAgentLoop): ChatTurnContext {
  return {
    config: FIXED_CONFIG,
    tools: [],
    signal: new AbortController().signal,
    agentLoop,
  };
}

async function drain(gen: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 测试用例
// ────────────────────────────────────────────────────────────────────────────

describe("ChatSession - 构造与 meta", () => {
  test("初始 snapshot 为空；meta 从构造函数带入", () => {
    const s = new ChatSession(FIXED_META);
    expect(s.snapshot()).toEqual([]);
    expect(s.meta).toEqual(FIXED_META);
  });

  test("可用 initialMessages 构造（便于 /load 场景）", () => {
    const history: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "hi" },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const s = new ChatSession(FIXED_META, history);
    expect(s.snapshot()).toEqual(history);
  });
});

describe("ChatSession - sendTurn 追加简单（无工具）单轮", () => {
  test("单轮 end_turn：snapshot = [user, assistant]", async () => {
    const assistantMsg: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "hi back" }],
    };
    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      { type: "text_delta", delta: "hi back" },
      {
        type: "turn_end",
        turn: 1,
        message: assistantMsg,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 1, finalMessage: assistantMsg },
    ]);

    const s = new ChatSession(FIXED_META);
    await drain(s.sendTurn("hello", makeCtx(agentLoop)));

    expect(s.snapshot()).toEqual([{ role: MessageRoleEnum.USER, content: "hello" }, assistantMsg]);
  });

  test("连续两轮对话 → snapshot 顺序严格递增", async () => {
    const assistant1: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "first answer" }],
    };
    const assistant2: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "second answer" }],
    };
    const loop1 = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: assistant1,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 1, finalMessage: assistant1 },
    ]);
    const loop2 = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: assistant2,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 1, finalMessage: assistant2 },
    ]);

    const s = new ChatSession(FIXED_META);
    await drain(s.sendTurn("q1", makeCtx(loop1)));
    await drain(s.sendTurn("q2", makeCtx(loop2)));

    expect(s.snapshot()).toEqual([
      { role: MessageRoleEnum.USER, content: "q1" },
      assistant1,
      { role: MessageRoleEnum.USER, content: "q2" },
      assistant2,
    ]);
  });
});

describe("ChatSession - sendTurn 含工具循环", () => {
  test("tool_use → tool_result → end_turn：snapshot 按 user→assistant(tool_use)→user(tool_result)→assistant(text) 排列", async () => {
    const assistantToolUse: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { message: "x" } }],
    };
    const assistantFinal: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "done" }],
    };

    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: assistantToolUse,
        stopReason: AgentStopReasonEnum.TOOL_USE,
      },
      { type: "tool_call", toolUseId: "tu_1", toolName: "echo", input: { message: "x" } },
      {
        type: "tool_result",
        toolUseId: "tu_1",
        toolName: "echo",
        content: "echo: x",
        isError: false,
      },
      // 第二轮开始：turn_start 会触发把累积的 tool_result 打包成 user 消息
      { type: "turn_start", turn: 2 },
      {
        type: "turn_end",
        turn: 2,
        message: assistantFinal,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 2, finalMessage: assistantFinal },
    ]);

    const s = new ChatSession(FIXED_META);
    await drain(s.sendTurn("use the tool", makeCtx(agentLoop)));

    expect(s.snapshot()).toEqual([
      { role: MessageRoleEnum.USER, content: "use the tool" },
      assistantToolUse,
      {
        role: MessageRoleEnum.USER,
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "echo: x" }],
      },
      assistantFinal,
    ]);
  });

  test("tool_result.isError=true 时 tool_result 块带 is_error 字段", async () => {
    const assistantToolUse: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "tool_use", id: "tu_1", name: "fail", input: {} }],
    };
    const assistantFinal: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "acknowledged failure" }],
    };

    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: assistantToolUse,
        stopReason: AgentStopReasonEnum.TOOL_USE,
      },
      { type: "tool_call", toolUseId: "tu_1", toolName: "fail", input: {} },
      {
        type: "tool_result",
        toolUseId: "tu_1",
        toolName: "fail",
        content: "boom",
        isError: true,
      },
      { type: "turn_start", turn: 2 },
      {
        type: "turn_end",
        turn: 2,
        message: assistantFinal,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 2, finalMessage: assistantFinal },
    ]);

    const s = new ChatSession(FIXED_META);
    await drain(s.sendTurn("run fail", makeCtx(agentLoop)));

    const snapshot = s.snapshot();
    const toolResultUser = snapshot[2];
    expect(toolResultUser).toEqual({
      role: MessageRoleEnum.USER,
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }],
    });
  });
});

describe("ChatSession - /clear /snapshot /restore 原子 API", () => {
  test("clear() 清空 messages 但保留 meta", async () => {
    const assistantMsg: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "hi" }],
    };
    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: assistantMsg,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 1, finalMessage: assistantMsg },
    ]);
    const s = new ChatSession(FIXED_META);
    await drain(s.sendTurn("hi", makeCtx(agentLoop)));
    expect(s.snapshot().length).toBe(2);

    s.clear();
    expect(s.snapshot()).toEqual([]);
    expect(s.meta).toEqual(FIXED_META); // meta 不应受 clear 影响
  });

  test("snapshot() 返回副本：外部修改不污染内部", () => {
    const s = new ChatSession(FIXED_META, [{ role: MessageRoleEnum.USER, content: "x" }]);
    const snap = s.snapshot() as NovaMessage[];
    snap.pop();
    expect(s.snapshot().length).toBe(1);
  });

  test("restore() 注入历史后继续 sendTurn，新消息追加在末尾", async () => {
    const restoredMeta: SessionMeta = {
      sessionId: "2026-05-04T11-00-00-11111111",
      model: "claude-test",
      createdAt: "2026-05-04T11:00:00.000Z",
    };
    const history: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "earlier turn" },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "earlier reply" }],
      },
    ];
    const newAssistant: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "text", text: "new reply" }],
    };
    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: newAssistant,
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      { type: "done", turns: 1, finalMessage: newAssistant },
    ]);

    const s = new ChatSession(FIXED_META);
    s.restore(restoredMeta, history);
    expect(s.meta).toEqual(restoredMeta);
    expect(s.snapshot()).toEqual(history);

    await drain(s.sendTurn("continue", makeCtx(agentLoop)));

    expect(s.snapshot()).toEqual([
      ...history,
      { role: MessageRoleEnum.USER, content: "continue" },
      newAssistant,
    ]);
  });
});

describe("ChatSession - sendTurn 中途抛错的原子性", () => {
  test("LLM 抛错：messages 保持调用前状态（不残留孤儿 user）", async () => {
    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      // 尚未 yield turn_end 就抛错
      { __throw: new Error("simulated LLM failure") },
    ]);

    const s = new ChatSession(FIXED_META, [{ role: MessageRoleEnum.USER, content: "earlier" }]);
    const beforeSnapshot = s.snapshot();

    await expect(drain(s.sendTurn("boom", makeCtx(agentLoop)))).rejects.toThrow(
      "simulated LLM failure",
    );

    // messages 没有吸收"boom"那条 user，也没残留任何新消息
    expect(s.snapshot()).toEqual(beforeSnapshot);
  });

  test("tool_use 后未完成 tool_result 就抛错：不追加任何本轮消息", async () => {
    const assistantToolUse: NovaMessage = {
      role: MessageRoleEnum.ASSISTANT,
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: {} }],
    };
    const agentLoop = makeFakeAgentLoop([
      { type: "turn_start", turn: 1 },
      {
        type: "turn_end",
        turn: 1,
        message: assistantToolUse,
        stopReason: AgentStopReasonEnum.TOOL_USE,
      },
      { __throw: new Error("abort mid-tool") },
    ]);

    const s = new ChatSession(FIXED_META);
    await expect(drain(s.sendTurn("q", makeCtx(agentLoop)))).rejects.toThrow("abort mid-tool");
    // 即使已经收到 turn_end，本轮整体 rollback
    expect(s.snapshot()).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M4 compact()
// ────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompactContext } from "./ChatSession.ts";

function makeFakeClientFactory(text: string) {
  const final: SdkMessage = {
    id: "msg_compact_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text, citations: null }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
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
  return (_config: unknown): Anthropic =>
    ({
      messages: {
        stream: () => ({
          [Symbol.asyncIterator]() {
            return { next: async () => ({ done: true, value: undefined }) };
          },
          finalMessage: async () => final,
        }),
      },
    }) as unknown as Anthropic;
}

function makeCompactCtx(
  clientFactory: ReturnType<typeof makeFakeClientFactory>,
): ChatCompactContext {
  return {
    config: FIXED_CONFIG,
    signal: new AbortController().signal,
    clientFactory,
  };
}

describe("ChatSession.compact()", () => {
  test("空 messages → 抛错", async () => {
    const s = new ChatSession(FIXED_META);
    await expect(s.compact(makeCompactCtx(makeFakeClientFactory("x")))).rejects.toThrow();
  });

  test("成功 → messages 重置为单条 summary user message", async () => {
    const s = new ChatSession(FIXED_META, [
      { role: MessageRoleEnum.USER, content: "first question" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "first answer" }] },
      { role: MessageRoleEnum.USER, content: "second question" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "second answer" }] },
    ]);
    const ctx = makeCompactCtx(makeFakeClientFactory("<summary>kept everything</summary>"));
    const outcome = await s.compact(ctx);

    expect(outcome.compactedMessages).toBe(4);
    expect(outcome.preCompactTokenCount).toBeGreaterThan(0);
    expect(outcome.postCompactTokenCount).toBeGreaterThan(0);

    const after = s.snapshot();
    expect(after.length).toBe(1);
    expect(after[0]?.role).toBe(MessageRoleEnum.USER);
    if (typeof after[0]?.content === "string") {
      expect(after[0]?.content).toContain("Summary:");
      expect(after[0]?.content).toContain("kept everything");
    }
  });

  test("失败时 messages 不变（原子性）", async () => {
    // 给空文本 → compactConversation 抛 INCOMPLETE_RESPONSE
    const original: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "hi" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "hello" }] },
    ];
    const s = new ChatSession(FIXED_META, original);
    const ctx = makeCompactCtx(makeFakeClientFactory(""));
    await expect(s.compact(ctx)).rejects.toThrow();
    expect(s.snapshot()).toEqual(original);
  });

  test("customInstructions 传入 compactConversation", async () => {
    // 用 spy 验证 customInstructions 是否会进入实际 LLM 请求
    let capturedBody: unknown;
    const final: SdkMessage = {
      id: "x",
      type: "message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "<summary>ok</summary>", citations: null }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
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
    const spyClient: Anthropic = {
      messages: {
        // biome-ignore lint/suspicious/noExplicitAny: spy
        stream: (body: any) => {
          capturedBody = body;
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => ({ done: true, value: undefined }) };
            },
            finalMessage: async () => final,
          };
        },
      },
    } as unknown as Anthropic;
    const s = new ChatSession(FIXED_META, [
      { role: MessageRoleEnum.USER, content: "q" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "a" }] },
    ]);
    await s.compact(
      {
        config: FIXED_CONFIG,
        signal: new AbortController().signal,
        clientFactory: () => spyClient,
      },
      "extra hint",
    );
    // biome-ignore lint/suspicious/noExplicitAny: spy
    const lastMsg = (capturedBody as any).messages.at(-1);
    expect(lastMsg.content).toContain("Additional Instructions:");
    expect(lastMsg.content).toContain("extra hint");
  });
});
