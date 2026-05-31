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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  Message as SdkMessage,
} from "@anthropic-ai/sdk/resources/messages";
import type { ResolvedConfig } from "./config/config.ts";
import { AbortError, MaxTurnsExceededError } from "./errors/index.ts";
import { buildSystemPrompt, runAgentLoop } from "./QueryEngine.ts";
import { HookCommandType } from "./services/hooks/types.ts";
import type { PermissionProvider } from "./services/permissions/PermissionProvider.ts";
import { PermissionStore } from "./services/permissions/permissionStore.ts";
import { createPlanModeRuntime } from "./services/plan/index.ts";
import { createProjectInstructionsRuntime } from "./services/projectInstructions/index.ts";
import type { Tool } from "./Tool.ts";
import { AgentTool } from "./tools/AgentTool/AgentTool.ts";
import { AGENT_TOOL_NAME } from "./tools/AgentTool/constants.ts";
import { ExitPlanModeTool } from "./tools.ts";
import { type AgentEvent, AgentStopReasonEnum, MessageRoleEnum } from "./types/message.ts";
import type { PermissionRule, UserChoice } from "./types/permissions.ts";

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
  /** 完整的 system prompt，用于断言 M6 TodoWrite guidance 注入。 */
  readonly system?: unknown;
  /** SDK tools 中暴露的工具名，用于断言子 agent 不允许递归派生。 */
  readonly toolNames: readonly string[];
  /** 完整的 messages body（按 SDK 期望的 shape），用于断言历史消息前置正确。 */
  readonly messages: readonly unknown[];
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
          system?: unknown;
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
          toolNames: extractToolNames(body.tools),
          messageCount: body.messages.length,
          system: body.system,
          messages: body.messages,
        });
        return makeFakeStream(turn);
      },
    },
  } as unknown as Anthropic;

  return { client: fakeClient, calls };
}

function extractToolNames(tools: readonly unknown[] | undefined): readonly string[] {
  if (tools === undefined) return [];
  return tools
    .map((tool) => {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return undefined;
      const record = tool as Readonly<Record<string, unknown>>;
      return typeof record["name"] === "string" ? record["name"] : undefined;
    })
    .filter((name): name is string => name !== undefined);
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
  webProxy: undefined,
  webProxyDomains: [],
  mcpServers: {},
  hooks: {},
  autoMemoryEnabled: false,
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

describe("buildSystemPrompt - M6 TodoWrite guidance", () => {
  test("TodoWrite 可用时，在默认 system prompt 后追加工具使用引导", () => {
    const prompt = buildSystemPrompt({ toolNames: ["TodoWrite"] });

    expect(prompt).toContain("You are nova-code");
    expect(prompt).toContain("## TodoWrite guidance");
    expect(prompt).toContain("3+ meaningful steps");
  });

  test("TodoWrite 不可用时，不注入 TodoWrite 引导", () => {
    const prompt = buildSystemPrompt({ toolNames: ["Bash"] });

    expect(prompt).not.toContain("## TodoWrite guidance");
  });

  test("显式 systemPrompt 保持原样，避免手动 compact 路径重复注入", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "custom system",
      toolNames: ["TodoWrite"],
    });

    expect(prompt).toBe("custom system");
  });
});

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

  test("FileRead 命中 path-scoped rule 后，下一轮 system prompt 注入该 rule", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nova-query-rules-"));
    try {
      await Bun.write(join(tempDir, ".git"), "gitdir: fake");
      await Bun.write(join(tempDir, "src", "a.ts"), "export const a = 1;\n");
      await Bun.write(
        join(tempDir, ".claude", "rules", "ts.md"),
        `---
paths: ["src/**/*.ts"]
---
QUERY_TS_RULE_MARKER
`,
      );
      const runtime = await createProjectInstructionsRuntime({
        cwd: tempDir,
        homeDir: join(tempDir, "home-empty"),
        managedDir: join(tempDir, "etc-empty"),
      });
      const fileReadTool: Tool = {
        name: "FileRead",
        description: "read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execute: () => "file contents",
      };
      const { client, calls } = makeFakeClient([
        {
          textChunks: [],
          toolUses: [{ id: "tu_read", name: "FileRead", input: { path: "src/a.ts" } }],
          stopReason: "tool_use",
        },
        { textChunks: ["done"], stopReason: "end_turn" },
      ]);

      await collectEvents(
        runAgentLoop({
          config: baseConfig,
          userPrompt: "read the TypeScript file",
          tools: [fileReadTool],
          client,
          cwd: tempDir,
          projectInstructionsRuntime: runtime,
        }),
      );

      expect(String(calls[0]?.system ?? "")).not.toContain("QUERY_TS_RULE_MARKER");
      expect(String(calls[1]?.system ?? "")).toContain("QUERY_TS_RULE_MARKER");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("AgentTool 派生子 agent，父 agent 只收到最终摘要", async () => {
    const { client, calls } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [
          {
            id: "tu_agent",
            name: AGENT_TOOL_NAME,
            input: {
              description: "Inspect config path",
              prompt: "Find how config path is resolved. Report under 50 words.",
              subagent_type: "explore",
            },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Config uses ~/.nova-code/config.json."],
        stopReason: "end_turn",
      },
      {
        textChunks: ["The sub-agent found the config path."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "delegate config lookup",
        tools: [AgentTool, makeEchoTool()],
        client,
      }),
    );

    expect(calls.length).toBe(3);
    expect(calls[1]?.toolNames).not.toContain(AGENT_TOOL_NAME);
    expect(String(calls[1]?.system ?? "")).toContain("sub-agent");
    const agentResult = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && event.toolName === AGENT_TOOL_NAME,
    );
    expect(agentResult?.isError).toBe(false);
    expect(agentResult?.content).toContain("Sub-agent completed");
    expect(agentResult?.content).toContain("Config uses ~/.nova-code/config.json.");
  });

  test("PreToolUse hook 可改写工具入参，PostToolUse hook 可改写工具结果", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nova-query-hooks-"));
    try {
      const preScript = join(tempDir, "pre.ts");
      const postScript = join(tempDir, "post.ts");
      await Bun.write(
        preScript,
        `const input = await new Response(Bun.stdin.stream()).json();
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse",
  updatedInput: { message: input.tool_input.message + "-pre" }
}}));
`,
      );
      await Bun.write(
        postScript,
        `const input = await new Response(Bun.stdin.stream()).json();
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PostToolUse",
  updatedOutput: input.tool_response + "-post"
}}));
`,
      );

      const { client } = makeFakeClient([
        {
          textChunks: [],
          toolUses: [{ id: "tu_1", name: "echo", input: { message: "x" } }],
          stopReason: "tool_use",
        },
        { textChunks: ["done"], stopReason: "end_turn" },
      ]);

      const events = await collectEvents(
        runAgentLoop({
          config: baseConfig,
          userPrompt: "test hooks",
          tools: [makeEchoTool()],
          client,
          cwd: tempDir,
          hooks: {
            PreToolUse: [
              {
                matcher: "echo",
                hooks: [{ type: HookCommandType.COMMAND, command: `bun run ${preScript}` }],
              },
            ],
            PostToolUse: [
              {
                matcher: "echo",
                hooks: [{ type: HookCommandType.COMMAND, command: `bun run ${postScript}` }],
              },
            ],
          },
        }),
      );

      const hookResults = events.filter((event) => event.type === "hook_result");
      expect(hookResults.length).toBe(2);
      const toolResult = events.find(
        (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
          event.type === "tool_result",
      );
      expect(toolResult?.content).toBe("echo: x-pre-post");
      expect(toolResult?.isError).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("PreToolUse hook 阻断时不执行工具，并返回 is_error tool_result", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nova-query-hooks-block-"));
    try {
      const preScript = join(tempDir, "pre-block.ts");
      await Bun.write(preScript, `console.error("blocked before execute"); process.exit(2);\n`);
      const { client } = makeFakeClient([
        {
          textChunks: [],
          toolUses: [{ id: "tu_1", name: "echo", input: { message: "x" } }],
          stopReason: "tool_use",
        },
        { textChunks: ["done"], stopReason: "end_turn" },
      ]);
      const executed: string[] = [];
      const tool: Tool = {
        ...makeEchoTool(),
        execute: () => {
          executed.push("called");
          return "should not happen";
        },
      };

      const events = await collectEvents(
        runAgentLoop({
          config: baseConfig,
          userPrompt: "test hook block",
          tools: [tool],
          client,
          cwd: tempDir,
          hooks: {
            PreToolUse: [
              {
                matcher: "echo",
                hooks: [{ type: HookCommandType.COMMAND, command: `bun run ${preScript}` }],
              },
            ],
          },
        }),
      );

      expect(executed).toEqual([]);
      const toolResult = events.find(
        (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
          event.type === "tool_result",
      );
      expect(toolResult?.isError).toBe(true);
      expect(toolResult?.content).toContain("Hook blocked");
      expect(toolResult?.content).toContain("blocked before execute");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

describe("runAgentLoop - initialMessages（多轮 REPL 支持）", () => {
  test("不传 initialMessages：messages 只包含当前 userPrompt（向后兼容）", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hello",
        tools: [],
        client,
      }),
    );
    expect(calls[0]?.messageCount).toBe(1);
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("传 userMessageContent：首轮 user message 使用结构化附件内容", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    const userMessageContent = [
      { type: "text", text: "review @src/a.ts" },
      { type: "text", text: '<attachment type="file">content</attachment>' },
    ] as const;

    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "review @src/a.ts",
        userMessageContent,
        tools: [],
        client,
      }),
    );

    expect(calls[0]?.messages).toEqual([{ role: "user", content: userMessageContent }]);
  });

  test("传 initialMessages：历史消息被完整前置到请求 messages，userPrompt 追加在末尾", async () => {
    const { client, calls } = makeFakeClient([
      { textChunks: ["acknowledged"], stopReason: "end_turn" },
    ]);

    // 构造一段「上一轮 user + assistant」的历史，模拟多轮 REPL 第二轮的入参
    const history = [
      { role: MessageRoleEnum.USER, content: "first question" },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "first answer" } as const],
      },
    ] as const;

    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "follow up",
        initialMessages: history,
        tools: [],
        client,
      }),
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.messageCount).toBe(3);
    // 顺序必须是：[历史 user, 历史 assistant, 新 userPrompt]
    expect(calls[0]?.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: "follow up" },
    ]);
  });

  test("initialMessages + tool_use 循环：第二轮 SDK 调用仍包含历史前缀", async () => {
    const { client, calls } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "echo", input: { message: "x" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const history = [
      { role: MessageRoleEnum.USER, content: "earlier turn" },
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "text", text: "earlier reply" } as const],
      },
    ] as const;

    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "now use echo",
        initialMessages: history,
        tools: [makeEchoTool()],
        client,
      }),
    );

    expect(calls.length).toBe(2);
    // 第一轮：[历史 user, 历史 assistant, 新 user]
    expect(calls[0]?.messageCount).toBe(3);
    // 第二轮：第一轮基础上追加 [assistant(tool_use), user(tool_result)] → 共 5
    expect(calls[1]?.messageCount).toBe(5);
    // 前两条仍是历史（防止实现里把 initialMessages 错当成「只用一轮」）
    const secondCallMessages = calls[1]?.messages;
    expect(secondCallMessages?.[0]).toEqual({ role: "user", content: "earlier turn" });
    expect(secondCallMessages?.[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "earlier reply" }],
    });
    expect(secondCallMessages?.[2]).toEqual({ role: "user", content: "now use echo" });
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

  test("TodoWrite 工具可用时，SDK system 字段包含 TodoWrite guidance", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "test",
        tools: [
          {
            ...makeEchoTool(),
            name: "TodoWrite",
          },
        ],
        client,
      }),
    );

    expect(String(calls[0]?.system ?? "")).toContain("## TodoWrite guidance");
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

describe("runAgentLoop - llmLogSink", () => {
  test("每轮 LLM 调用都写入 llm_request 和 llm_response", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "echo", input: { message: "x" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const records: Array<Record<string, unknown>> = [];
    const sink = {
      write: (payload: unknown) => {
        records.push(payload as Record<string, unknown>);
      },
    };

    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "go",
        tools: [makeEchoTool()],
        client,
        llmLogSink: sink,
      }),
    );

    // 两轮 LLM 调用 → 2 条 request + 2 条 response
    const kinds = records.map((r) => r["kind"]);
    expect(kinds).toEqual(["llm_request", "llm_response", "llm_request", "llm_response"]);

    // 请求字段：turn / model / params.messages 齐全
    const firstReq = records[0];
    expect(firstReq?.["turn"]).toBe(1);
    expect(firstReq?.["model"]).toBe(baseConfig.model);
    const params = firstReq?.["params"] as { messages: unknown[]; tools?: unknown[] };
    expect(Array.isArray(params.messages)).toBe(true);
    expect(params.messages.length).toBe(1);
    expect(Array.isArray(params.tools)).toBe(true);

    // 响应字段：stopReason / durationMs / message 齐全
    const firstResp = records[1];
    expect(firstResp?.["turn"]).toBe(1);
    expect(firstResp?.["stopReason"]).toBe("tool_use");
    expect(typeof firstResp?.["durationMs"]).toBe("number");
    expect(firstResp?.["message"]).toBeDefined();

    // 第二轮 turn 递增
    expect(records[2]?.["turn"]).toBe(2);
    expect(records[3]?.["turn"]).toBe(2);
    expect(records[3]?.["stopReason"]).toBe("end_turn");
  });

  test("不传 llmLogSink：零调用（向后兼容）", async () => {
    // 既然不传 sink，只要 loop 正常跑完不抛就算通过——用 Fake client 调用次数作 smoke 断言
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [],
        client,
      }),
    );
    expect(calls.length).toBe(1);
  });

  test("sink.write 抛错不阻断 LLM 调用", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["ok"], stopReason: "end_turn" }]);
    const sink = {
      write: () => {
        throw new Error("sink broken");
      },
    };

    // 期望 runAgentLoop 正常结束（fail-safe），而不是把 sink 的错误冒上来
    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [],
        client,
        llmLogSink: sink,
      }),
    );
    expect(calls.length).toBe(1);
    expect(events[events.length - 1]?.type).toBe("done");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M3 权限系统注入
// ────────────────────────────────────────────────────────────────────────────

function makeBashTool(requiresApproval: boolean): Tool {
  return {
    name: "Bash",
    description: "run shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: (input) => {
      const { command } = input as { command?: unknown };
      return `ran: ${String(command ?? "")}`;
    },
    requiresApproval,
  };
}

function makeFileWriteProbeTool(): Tool {
  return {
    name: "FileWrite",
    description: "probe file write",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: () => "write executed",
    requiresApproval: false,
  };
}

function makeInMemoryStore(initialRules: readonly PermissionRule[] = []): PermissionStore {
  return new PermissionStore({
    cwd: "/tmp/nova-test",
    projectRules: [],
    globalRules: [],
    sessionRules: initialRules,
  });
}

function makeProvider(choice: UserChoice): PermissionProvider & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    requestPermission: (req) => {
      calls.push(req);
      return Promise.resolve(choice);
    },
  };
}

describe("runAgentLoop - M3 权限注入", () => {
  test("不传权限参数：行为与 M1/M2 等价，无 permission_* 事件", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(true)],
        client,
      }),
    );

    const permissionEvents = events.filter(
      (e) => e.type === "permission_request" || e.type === "permission_decision",
    );
    expect(permissionEvents.length).toBe(0);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as AgentEvent & { type: "tool_result" }).isError).toBe(false);
  });

  test("deny 规则命中：不 execute，tool_result is_error=true", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "git push --force" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const store = makeInMemoryStore([{ toolName: "Bash", ruleContent: "git:*", behavior: "deny" }]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(false)],
        client,
        permissionMode: "default",
        permissionStore: store,
      }),
    );

    const decisions = events.filter((e) => e.type === "permission_decision");
    expect(decisions.length).toBe(1);
    expect((decisions[0] as AgentEvent & { type: "permission_decision" }).decision).toBe("deny");
    const toolResults = events.filter((e) => e.type === "tool_result");
    const tr = toolResults[0] as AgentEvent & { type: "tool_result" };
    expect(tr.isError).toBe(true);
    expect(String(tr.content)).toContain("Permission denied");
  });

  test("ask + 无 provider → 安全降级为 deny", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(true)],
        client,
        permissionMode: "default",
        permissionStore: makeInMemoryStore(),
      }),
    );

    const decisions = events.filter((e) => e.type === "permission_decision");
    expect((decisions[0] as AgentEvent & { type: "permission_decision" }).decision).toBe("deny");
    expect(String((decisions[0] as AgentEvent & { type: "permission_decision" }).reason)).toContain(
      "no permission provider",
    );
  });

  test("ask + provider 返回 allow-once → 正常 execute，不持久化", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const store = makeInMemoryStore();
    const provider = makeProvider("allow-once");

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(true)],
        client,
        permissionMode: "default",
        permissionStore: store,
        permissionProvider: provider,
      }),
    );

    expect(provider.calls.length).toBe(1);
    const requests = events.filter((e) => e.type === "permission_request");
    expect(requests.length).toBe(1);
    const decisions = events.filter((e) => e.type === "permission_decision");
    expect((decisions[0] as AgentEvent & { type: "permission_decision" }).decision).toBe("allow");
    expect(store.listBySource("session").length).toBe(0);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect((toolResults[0] as AgentEvent & { type: "tool_result" }).isError).toBe(false);
  });

  test("ask + provider 返回 allow-always-session → 写入 session 规则", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls -la" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const store = makeInMemoryStore();
    const provider = makeProvider("allow-always-session");

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(true)],
        client,
        permissionMode: "default",
        permissionStore: store,
        permissionProvider: provider,
      }),
    );

    const sessionRules = store.listBySource("session");
    expect(sessionRules.length).toBe(1);
    expect(sessionRules[0]).toEqual({
      toolName: "Bash",
      ruleContent: "ls:*",
      behavior: "allow",
    });
    const decisions = events.filter((e) => e.type === "permission_decision");
    const dec = decisions[0] as AgentEvent & { type: "permission_decision" };
    expect(dec.decision).toBe("allow");
    expect(dec.persisted).toBe("session");
  });

  test("bypassPermissions 模式：Bash 普通命令直接放行，不问用户", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const provider = makeProvider("deny"); // 不该被调
    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(true)],
        client,
        permissionMode: "bypassPermissions",
        permissionStore: makeInMemoryStore(),
        permissionProvider: provider,
      }),
    );

    expect(provider.calls.length).toBe(0);
    const permissionEvents = events.filter(
      (e) => e.type === "permission_request" || e.type === "permission_decision",
    );
    expect(permissionEvents.length).toBe(0);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect((toolResults[0] as AgentEvent & { type: "tool_result" }).isError).toBe(false);
  });

  test("DENY_PATTERNS 在 bypassPermissions 下仍然拦截", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "rm -rf /" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(false)],
        client,
        permissionMode: "bypassPermissions",
        permissionStore: makeInMemoryStore(),
      }),
    );

    const decisions = events.filter((e) => e.type === "permission_decision");
    expect((decisions[0] as AgentEvent & { type: "permission_decision" }).decision).toBe("deny");
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect((toolResults[0] as AgentEvent & { type: "tool_result" }).isError).toBe(true);
  });

  test("plan 模式：批准前 Bash 被拦截，即使没有 permissionStore", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "echo should-not-run" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hi",
        tools: [makeBashTool(false)],
        client,
        permissionMode: "plan",
      }),
    );

    const decisions = events.filter((e) => e.type === "permission_decision");
    expect((decisions[0] as AgentEvent & { type: "permission_decision" }).decision).toBe("deny");
    const toolResults = events.filter((e) => e.type === "tool_result");
    const result = toolResults[0] as AgentEvent & { type: "tool_result" };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("plan mode blocks");
  });

  test("ExitPlanMode 获批后，同一 loop 后续工具按进入前模式执行", async () => {
    const planRuntime = createPlanModeRuntime({
      approvalProvider: {
        requestPlanApproval: async () => ({ decision: "approved" }),
      },
    });
    planRuntime.enter({ previousPermissionMode: "default" });
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [
          {
            id: "tu_plan",
            name: "ExitPlanMode",
            input: { plan: "1. update code\n2. run tests" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: [],
        toolUses: [{ id: "tu_write", name: "FileWrite", input: { path: "a.ts" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "plan then implement",
        tools: [ExitPlanModeTool, makeFileWriteProbeTool()],
        client,
        permissionMode: "plan",
        planModeRuntime: planRuntime,
      }),
    );

    const toolResults = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(toolResults.map((event) => event.isError)).toEqual([false, false]);
    expect(toolResults[1]?.content).toBe("write executed");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M16: MemoryRuntime 注入
// ────────────────────────────────────────────────────────────────────────────

interface FakeMemoryRuntimeHandle {
  readonly runtime: import("./services/memory/index.ts").MemoryRuntime;
  readonly state: {
    refreshCalls: number;
    extractorCalls: number;
    instructions: string | undefined;
  };
}

function makeFakeMemoryRuntime(opts?: {
  readonly memoryDir?: string;
  readonly instructions?: string;
}): FakeMemoryRuntimeHandle {
  const state = {
    refreshCalls: 0,
    extractorCalls: 0,
    instructions: opts?.instructions,
  };
  const runtime: import("./services/memory/index.ts").MemoryRuntime = {
    memoryDir: opts?.memoryDir ?? "/fake/mem/projects/foo/",
    entrypointPath: `${opts?.memoryDir ?? "/fake/mem/projects/foo/"}MEMORY.md`,
    getInstructions: () => state.instructions,
    refreshInstructions: async () => {
      state.refreshCalls += 1;
    },
    resolveRelevantMemories: async () => [],
    markSurfaced: () => {},
    runExtractorIfNeeded: async () => {
      state.extractorCalls += 1;
    },
  };
  return { runtime, state };
}

function makeFileWriteApprovalProbeTool(): Tool {
  return {
    name: "FileWrite",
    description: "fake file write that probes permission",
    requiresApproval: true,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: () => "wrote",
  };
}

describe("runAgentLoop - M16 memory integration", () => {
  test("memoryRuntime.getInstructions 被合并进 system prompt", async () => {
    const { client, calls } = makeFakeClient([{ textChunks: ["hi"], stopReason: "end_turn" }]);
    const { runtime } = makeFakeMemoryRuntime({
      instructions: "# auto memory\n\nINJECTED-MEMORY-MARKER",
    });
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hello",
        tools: [],
        client,
        memoryRuntime: runtime,
      }),
    );
    expect(calls[0]?.system).toContain("INJECTED-MEMORY-MARKER");
  });

  test("refreshInstructions 每轮调一次", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [{ id: "tu1", name: "echo", input: { message: "hi" } }],
        stopReason: "tool_use",
      },
      { textChunks: ["done"], stopReason: "end_turn" },
    ]);
    const { runtime, state } = makeFakeMemoryRuntime({ instructions: "mem" });
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hello",
        tools: [makeEchoTool()],
        client,
        memoryRuntime: runtime,
      }),
    );
    // 主循环跑了 2 turn → refresh 2 次
    expect(state.refreshCalls).toBe(2);
  });

  test("runExtractorIfNeeded 在 end_turn 后 fire-and-forget", async () => {
    const { client } = makeFakeClient([{ textChunks: ["done"], stopReason: "end_turn" }]);
    const { runtime, state } = makeFakeMemoryRuntime();
    await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "hello",
        tools: [],
        client,
        memoryRuntime: runtime,
      }),
    );
    // 给 microtask queue 一次机会消化
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(state.extractorCalls).toBe(1);
  });

  test("FileWrite 到 memoryDir 内 → carve-out 自动放行（无需审批）", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [
          {
            id: "tu_mem",
            name: "FileWrite",
            input: { path: "/fake/mem/projects/foo/feedback.md", content: "x" },
          },
        ],
        stopReason: "tool_use",
      },
      { textChunks: ["saved"], stopReason: "end_turn" },
    ]);
    const { runtime } = makeFakeMemoryRuntime({ memoryDir: "/fake/mem/projects/foo/" });
    const tmpHome = await mkdtemp(join(tmpdir(), "nova-mem-carveout-"));
    try {
      const events = await collectEvents(
        runAgentLoop({
          config: baseConfig,
          userPrompt: "save memory",
          tools: [makeFileWriteApprovalProbeTool()],
          client,
          memoryRuntime: runtime,
          permissionMode: "default",
          permissionStore: makeInMemoryStore(),
          // 不传 permissionProvider：默认会把 ask 降级 deny；
          // 若 carve-out 生效则不应触发 ask，工具应成功执行。
        }),
      );
      const results = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(false);
      expect(results[0]?.content).toBe("wrote");
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test("FileWrite 到 memoryDir 外 → 仍需审批（carve-out 不影响他处）", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: [],
        toolUses: [
          {
            id: "tu_other",
            name: "FileWrite",
            input: { path: "/work/src/foo.ts", content: "x" },
          },
        ],
        stopReason: "tool_use",
      },
      { textChunks: ["ok"], stopReason: "end_turn" },
    ]);
    const { runtime } = makeFakeMemoryRuntime({ memoryDir: "/fake/mem/projects/foo/" });
    const tmpHome = await mkdtemp(join(tmpdir(), "nova-mem-carveout-out-"));
    try {
      const events = await collectEvents(
        runAgentLoop({
          config: baseConfig,
          userPrompt: "write non-memory",
          tools: [makeFileWriteApprovalProbeTool()],
          client,
          memoryRuntime: runtime,
          permissionMode: "default",
          permissionStore: makeInMemoryStore(),
          // 不传 permissionProvider → ask 降级为 deny
        }),
      );
      const results = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});
