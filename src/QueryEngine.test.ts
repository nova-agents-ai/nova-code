/**
 * Agent loop 单元测试（M1.5 起从 src/llm/query.test.ts 搬到此处）。
 *
 * 关键技术：构造一个 Fake Anthropic Client，让 messages.stream() 按脚本
 * 返回预设的事件序列。这样可以完全脱离网络验证：
 * - 单轮无工具调用 → 应该 done
 * - 单轮有工具调用 → 应该执行工具、把结果回传、再调一次 LLM
 * - 工具抛错 → tool_result.is_error=true，loop 继续
 * - 模型要求未知工具 → tool_result.is_error=true，loop 继续
 * - 超过 maxTurns → 抛 MaxTurnsExceededError
 * - 用户 abort → 抛 AbortError
 */

import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  Message as SdkMessage,
} from "@anthropic-ai/sdk/resources/messages";
import type { ResolvedConfig } from "./config/config.ts";
import { AbortError, MaxTurnsExceededError } from "./errors/index.ts";
import { runAgentLoop } from "./QueryEngine.ts";
import type { Tool } from "./Tool.ts";
import { type AgentEvent, AgentStopReasonEnum } from "./types/message.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fake SDK Client
// ────────────────────────────────────────────────────────────────────────────

/** 单轮模拟响应：流式产出哪些 text，最终的 stop_reason 是什么，是否有 tool_use。 */
interface ScriptedTurn {
  readonly textChunks: readonly string[];
  readonly toolUses?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  }[];
  readonly stopReason: SdkMessage["stop_reason"];
}

interface FakeStreamCall {
  readonly model: string;
  readonly hasTools: boolean;
  readonly messageCount: number;
}

interface FakeClientHandle {
  readonly client: Anthropic;
  readonly calls: FakeStreamCall[];
}

function makeFakeClient(turns: readonly ScriptedTurn[]): FakeClientHandle {
  const calls: FakeStreamCall[] = [];
  let turnIndex = 0;

  const fakeClient = {
    messages: {
      stream: (
        body: {
          model: string;
          messages: readonly unknown[];
          tools?: readonly unknown[];
        },
        _options?: unknown,
      ) => {
        const turn = turns[turnIndex];
        if (turn === undefined) {
          throw new Error(
            `Fake client received unexpected ${turnIndex + 1}-th call (only ${turns.length} turns scripted).`,
          );
        }
        turnIndex += 1;
        calls.push({
          model: body.model,
          hasTools: body.tools !== undefined && body.tools.length > 0,
          messageCount: body.messages.length,
        });
        return makeFakeStream(turn);
      },
    },
  } as unknown as Anthropic;

  return { client: fakeClient, calls };
}

function makeFakeStream(turn: ScriptedTurn): {
  [Symbol.asyncIterator]: () => AsyncIterator<RawMessageStreamEvent>;
  finalMessage: () => Promise<SdkMessage>;
} {
  const events: RawMessageStreamEvent[] = [];
  // 文本 chunks 转成 content_block_delta 事件（block index 0）
  for (const chunk of turn.textChunks) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    } as RawMessageStreamEvent);
  }

  // 把脚本里的 toolUses + textChunks 转成最终的 SDK Message
  const content: SdkMessage["content"] = [];
  if (turn.textChunks.length > 0) {
    content.push({
      type: "text",
      text: turn.textChunks.join(""),
      citations: null,
    } as SdkMessage["content"][number]);
  }
  for (const use of turn.toolUses ?? []) {
    content.push({
      type: "tool_use",
      id: use.id,
      name: use.name,
      input: use.input,
    } as SdkMessage["content"][number]);
  }

  const finalMessage: SdkMessage = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: turn.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
  } as unknown as SdkMessage;

  return {
    [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
          if (i >= events.length) return { done: true, value: undefined };
          const event = events[i];
          i += 1;
          if (event === undefined) return { done: true, value: undefined };
          return { done: false, value: event };
        },
      };
    },
    finalMessage: () => Promise.resolve(finalMessage),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 通用 fixtures
// ────────────────────────────────────────────────────────────────────────────

const baseConfig: ResolvedConfig = {
  apiKey: "sk-test",
  baseURL: undefined,
  model: "claude-test",
  maxTokens: 1024,
  maxTurns: 5,
};

function makeEchoTool(): Tool {
  return {
    name: "echo",
    description: "echo back the message",
    input_schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    // input 类型是 Readonly<Record<string, unknown>>（index signature）；
    // TS noPropertyAccessFromIndexSignature 要求 bracket，biome useLiteralKeys 偏好点号 ——
    // 通过先收窄到具名属性类型来同时满足两者
    execute: (input) => {
      const { message } = input as { message?: unknown };
      return `echo: ${String(message ?? "")}`;
    },
  };
}

function makeFailingTool(): Tool {
  return {
    name: "fail",
    description: "always throws",
    input_schema: { type: "object", properties: {} },
    execute: () => {
      throw new Error("boom");
    },
  };
}

async function collectEvents(
  generator: AsyncGenerator<AgentEvent, unknown, void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

// ────────────────────────────────────────────────────────────────────────────
// 测试用例
// ────────────────────────────────────────────────────────────────────────────

describe("runAgentLoop - 单轮无工具调用", () => {
  test("end_turn 立即结束，发出 text_delta 和 done 事件", async () => {
    const { client, calls } = makeFakeClient([
      {
        textChunks: ["Hello", ", world!"],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [],
        client,
      }),
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.hasTools).toBe(false);

    const types = events.map((e) => e.type);
    expect(types).toEqual(["turn_start", "text_delta", "text_delta", "turn_end", "done"]);

    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(deltas).toBe("Hello, world!");

    const turnEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end",
    );
    expect(turnEnd?.stopReason).toBe(AgentStopReasonEnum.END_TURN);
  });
});

describe("runAgentLoop - 工具调用循环", () => {
  test("第一轮 tool_use → 执行工具 → 第二轮 end_turn", async () => {
    const { client, calls } = makeFakeClient([
      {
        textChunks: ["Let me check..."],
        toolUses: [{ id: "tu_1", name: "echo", input: { message: "hi from model" } }],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Got it: hi"],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "use the echo tool",
        tools: [makeEchoTool()],
        client,
      }),
    );

    // 应该调了 2 次 LLM
    expect(calls.length).toBe(2);
    expect(calls[0]?.hasTools).toBe(true);
    // 第二轮的 messages 数 = user + assistant + (tool_result wrapped as user)
    expect(calls[1]?.messageCount).toBe(3);

    // 工具调用事件存在且参数正确
    const toolCall = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call",
    );
    expect(toolCall).toBeDefined();
    expect(toolCall?.toolName).toBe("echo");
    expect(toolCall?.input).toEqual({ message: "hi from model" });

    // 工具结果事件存在且无错误
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBe(false);
    expect(toolResult?.content).toBe("echo: hi from model");

    // 最后是 done
    expect(events[events.length - 1]?.type).toBe("done");
  });

  test("工具抛错 → is_error=true → 模型在第二轮结束", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "fail", input: {} }],
        stopReason: "tool_use",
      },
      {
        textChunks: ["I see the tool failed."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "use the failing tool",
        tools: [makeFailingTool()],
        client,
      }),
    );

    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("boom");
  });

  test("模型调用未注册工具 → is_error=true 并列出可用工具", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "nonexistent", input: {} }],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Sorry."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "test",
        tools: [makeEchoTool()],
        client,
      }),
    );

    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("Unknown tool");
    expect(toolResult?.content).toContain("echo"); // 应该列出可用工具
  });

  test("一次 turn 包含多个 tool_use → 全部并行执行", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [
          { id: "tu_1", name: "echo", input: { message: "first" } },
          { id: "tu_2", name: "echo", input: { message: "second" } },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["done"],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "test",
        tools: [makeEchoTool()],
        client,
      }),
    );

    const toolCalls = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call",
    );
    const toolResults = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);
    expect(toolResults.map((r) => r.content)).toEqual(["echo: first", "echo: second"]);
  });
});

describe("runAgentLoop - 终止条件", () => {
  test("超过 maxTurns 抛 MaxTurnsExceededError", async () => {
    // 配 maxTurns=2，但脚本里 3 轮都 tool_use，永远不 end_turn
    const config: ResolvedConfig = { ...baseConfig, maxTurns: 2 };
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "echo", input: { message: "x" } }],
        stopReason: "tool_use",
      },
      {
        textChunks: [],
        toolUses: [{ id: "tu_2", name: "echo", input: { message: "y" } }],
        stopReason: "tool_use",
      },
    ]);

    await expect(
      collectEvents(
        runAgentLoop({
          config,
          userPrompt: "loop forever",
          tools: [makeEchoTool()],
          client,
        }),
      ),
    ).rejects.toThrow(MaxTurnsExceededError);
  });

  test("启动前已 abort → 立即抛 AbortError", async () => {
    const { client } = makeFakeClient([{ textChunks: ["hi"], stopReason: "end_turn" }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectEvents(
        runAgentLoop({
          config: baseConfig,
          userPrompt: "test",
          tools: [],
          signal: controller.signal,
          client,
        }),
      ),
    ).rejects.toThrow(AbortError);
  });

  test("模型 stop_reason=max_tokens → 视作终止，不再循环", async () => {
    const { client, calls } = makeFakeClient([
      {
        textChunks: ["partial reply"],
        stopReason: "max_tokens",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "test",
        tools: [makeEchoTool()],
        client,
      }),
    );

    expect(calls.length).toBe(1);
    const turnEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end",
    );
    expect(turnEnd?.stopReason).toBe(AgentStopReasonEnum.MAX_TOKENS);
    expect(events[events.length - 1]?.type).toBe("done");
  });
});

describe("runAgentLoop - SDK 入参组装", () => {
  test("无工具时不传 tools 字段", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "test",
        tools: [],
        client,
      }),
    );
    expect(calls[0]?.hasTools).toBe(false);
  });

  test("有工具时传 tools 字段", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "test",
        tools: [makeEchoTool()],
        client,
      }),
    );
    expect(calls[0]?.hasTools).toBe(true);
  });

  test("model 字段从 config 透传到 SDK", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    await collectEvents(
      runAgentLoop({
        config: { ...baseConfig, model: "claude-haiku-9000" },
        userPrompt: "test",
        tools: [],
        client,
      }),
    );
    expect(calls[0]?.model).toBe("claude-haiku-9000");
  });
});
