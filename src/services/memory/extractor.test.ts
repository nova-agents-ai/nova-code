import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ResolvedConfig } from "../../config/config.ts";
import type { Tool } from "../../Tool.ts";
import { type AgentEvent, MessageRoleEnum, type NovaMessage } from "../../types/message.ts";
import {
  createMemoryExtractorFactory,
  EXTRACTOR_TOOL_WHITELIST,
  hasMemoryWritesSince,
} from "./extractor.ts";

const SIGNAL = new AbortController().signal;

function fakeConfig(): ResolvedConfig {
  return {
    apiKey: "sk-test",
    baseURL: undefined,
    model: "claude-test",
    maxTokens: 1024,
    maxTurns: 25,
    webProxy: undefined,
    webProxyDomains: [],
    mcpServers: {},
    hooks: {},
    autoMemoryEnabled: true,
  };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    input_schema: { type: "object", properties: {} },
    execute: () => `ran ${name}`,
  };
}

function fakeClient(): Anthropic {
  return {} as unknown as Anthropic;
}

describe("hasMemoryWritesSince", () => {
  const MEM_DIR = "/mem/projects/foo/";

  test("空 messages → false", () => {
    expect(hasMemoryWritesSince([], MEM_DIR)).toBe(false);
  });

  test("仅 user 消息 → false", () => {
    const messages: NovaMessage[] = [{ role: MessageRoleEnum.USER, content: "hi" }];
    expect(hasMemoryWritesSince(messages, MEM_DIR)).toBe(false);
  });

  test("assistant 含 FileWrite 到 memoryDir → true", () => {
    const messages: NovaMessage[] = [
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "FileWrite",
            input: { path: "/mem/projects/foo/feedback.md", content: "x" },
          },
        ],
      },
    ];
    expect(hasMemoryWritesSince(messages, MEM_DIR)).toBe(true);
  });

  test("assistant 含 FileEdit 到 memoryDir → true", () => {
    const messages: NovaMessage[] = [
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "FileEdit",
            input: { path: "/mem/projects/foo/MEMORY.md", old_string: "a", new_string: "b" },
          },
        ],
      },
    ];
    expect(hasMemoryWritesSince(messages, MEM_DIR)).toBe(true);
  });

  test("assistant 写 memoryDir 外的文件 → false", () => {
    const messages: NovaMessage[] = [
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "FileWrite",
            input: { path: "/work/src/foo.ts", content: "x" },
          },
        ],
      },
    ];
    expect(hasMemoryWritesSince(messages, MEM_DIR)).toBe(false);
  });

  test("非 FileWrite/FileEdit tool_use → false", () => {
    const messages: NovaMessage[] = [
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
      },
    ];
    expect(hasMemoryWritesSince(messages, MEM_DIR)).toBe(false);
  });
});

describe("EXTRACTOR_TOOL_WHITELIST", () => {
  test("含 6 类只读 + memory 写工具", () => {
    expect(EXTRACTOR_TOOL_WHITELIST.has("FileRead")).toBe(true);
    expect(EXTRACTOR_TOOL_WHITELIST.has("Grep")).toBe(true);
    expect(EXTRACTOR_TOOL_WHITELIST.has("Glob")).toBe(true);
    expect(EXTRACTOR_TOOL_WHITELIST.has("LS")).toBe(true);
    expect(EXTRACTOR_TOOL_WHITELIST.has("FileEdit")).toBe(true);
    expect(EXTRACTOR_TOOL_WHITELIST.has("FileWrite")).toBe(true);
  });

  test("不含 Bash / Agent / TodoWrite / Skill", () => {
    expect(EXTRACTOR_TOOL_WHITELIST.has("Bash")).toBe(false);
    expect(EXTRACTOR_TOOL_WHITELIST.has("Agent")).toBe(false);
    expect(EXTRACTOR_TOOL_WHITELIST.has("TodoWrite")).toBe(false);
    expect(EXTRACTOR_TOOL_WHITELIST.has("Skill")).toBe(false);
  });
});

describe("createMemoryExtractorFactory", () => {
  const MEM_DIR = "/mem/projects/foo/";

  test("空 messages → 不调 runAgentLoop", async () => {
    let called = false;
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = () => {
      called = true;
      // biome-ignore lint/correctness/useYield: fake test generator never yields
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        return { role: MessageRoleEnum.ASSISTANT, content: [] };
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("FileRead"), fakeTool("FileWrite")],
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    await extractor([]);
    expect(called).toBe(false);
  });

  test("hasMemoryWritesSince 命中 → 跳过 runAgentLoop", async () => {
    let called = false;
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = () => {
      called = true;
      // biome-ignore lint/correctness/useYield: fake test generator never yields
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        return { role: MessageRoleEnum.ASSISTANT, content: [] };
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("FileRead"), fakeTool("FileWrite")],
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    // 模拟主对话本轮已经写过 memory
    await extractor([
      {
        role: MessageRoleEnum.ASSISTANT,
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "FileWrite",
            input: { path: "/mem/projects/foo/x.md", content: "x" },
          },
        ],
      },
    ]);
    expect(called).toBe(false);
  });

  test("无白名单工具 → 不调 runAgentLoop", async () => {
    let called = false;
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = () => {
      called = true;
      // biome-ignore lint/correctness/useYield: fake test generator never yields
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        return { role: MessageRoleEnum.ASSISTANT, content: [] };
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("Bash"), fakeTool("WebSearch")], // 都不在白名单
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    await extractor([{ role: MessageRoleEnum.USER, content: "hi" }]);
    expect(called).toBe(false);
  });

  test("正常路径：调 runAgentLoop 并 drain 事件（>= 4 条新消息）", async () => {
    let invocation:
      | Parameters<Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"]>[0]
      | undefined;
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = (
      params,
    ) => {
      invocation = params;
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        yield { type: "turn_start", turn: 1 };
        yield {
          type: "done",
          turns: 1,
          finalMessage: {
            role: MessageRoleEnum.ASSISTANT,
            content: [{ type: "text", text: "done" }],
          },
        };
        return { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "done" }] };
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("FileRead"), fakeTool("FileWrite"), fakeTool("Bash") /* 应被过滤 */],
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    await extractor([
      { role: MessageRoleEnum.USER, content: "I'm a Go expert new to React" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "noted" }] },
      { role: MessageRoleEnum.USER, content: "what about hooks?" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "..." }] },
    ]);
    if (invocation === undefined) throw new Error("expected invocation to be set");
    expect(invocation.config.maxTurns).toBe(5);
    expect(invocation.userPrompt).toContain("Analyze");
    expect(invocation.userPrompt).toContain("Go expert");
    expect(invocation.systemPrompt).toContain("memory extraction subagent");
    expect(invocation.tools.map((t) => t.name).sort()).toEqual(["FileRead", "FileWrite"]);
  });

  test("短交互（< 4 条新消息）→ 跳过 runAgentLoop", async () => {
    let called = false;
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = () => {
      called = true;
      // biome-ignore lint/correctness/useYield: fake test generator never yields
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        return { role: MessageRoleEnum.ASSISTANT, content: [] };
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("FileRead"), fakeTool("FileWrite")],
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    // 只有 2 条新消息，未达到 EXTRACTOR_MIN_NEW_MESSAGES (4)
    await extractor([
      { role: MessageRoleEnum.USER, content: "hi" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "hello" }] },
    ]);
    expect(called).toBe(false);
  });

  test("游标推进：第二次调只看新 messages", async () => {
    let invocations = 0;
    let lastUserPrompt = "";
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = (
      params,
    ) => {
      invocations += 1;
      lastUserPrompt = params.userPrompt;
      // biome-ignore lint/correctness/useYield: fake test generator never yields
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        return { role: MessageRoleEnum.ASSISTANT, content: [] };
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("FileWrite"), fakeTool("FileRead")],
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    const messagesAfterTurn1: NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "msg1" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "reply1" }] },
      { role: MessageRoleEnum.USER, content: "msg1b" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "reply1b" }] },
    ];
    await extractor(messagesAfterTurn1);
    expect(invocations).toBe(1);
    expect(lastUserPrompt).toContain("Analyze the most recent 4 messages");

    const messagesAfterTurn2: NovaMessage[] = [
      ...messagesAfterTurn1,
      { role: MessageRoleEnum.USER, content: "msg2" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "reply2" }] },
      { role: MessageRoleEnum.USER, content: "msg2b" },
      { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "reply2b" }] },
    ];
    await extractor(messagesAfterTurn2);
    expect(invocations).toBe(2);
    expect(lastUserPrompt).toContain("Analyze the most recent 4 messages");
    expect(lastUserPrompt).toContain("msg2");
    expect(lastUserPrompt).not.toContain("msg1");
  });

  test("runAgentLoop 抛错不冒泡", async () => {
    const runAgentLoop: Parameters<typeof createMemoryExtractorFactory>[0]["runAgentLoop"] = () => {
      // biome-ignore lint/correctness/useYield: fake test generator never yields
      return (async function* (): AsyncGenerator<AgentEvent, NovaMessage, void> {
        throw new Error("boom");
      })();
    };
    const extractor = createMemoryExtractorFactory({
      runAgentLoop,
      client: fakeClient(),
      config: fakeConfig(),
      tools: [fakeTool("FileWrite"), fakeTool("FileRead")],
      memoryDir: MEM_DIR,
      signal: SIGNAL,
    });
    await expect(
      extractor([{ role: MessageRoleEnum.USER, content: "x" }]),
    ).resolves.toBeUndefined();
  });
});
