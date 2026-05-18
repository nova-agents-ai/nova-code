/**
 * 端到端集成测试 —— M1 工具系统在真实 agent loop 内的串联验证。
 *
 * 与 src/QueryEngine.test.ts 的关系：
 * - query.test.ts：聚焦 agent loop 自身行为（事件序列 / 工具失败 / abort / maxTurns），
 *   工具用 inline echo / fail mock，不碰真实 IO
 * - 本文件：聚焦 7 个内置工具（LS/FileRead/FileWrite/FileEdit/Bash/Grep/Glob）
 *   组合在真实文件系统上的行为，仅 mock LLM 这一头
 *
 * 主场景：4 轮 edit-loop（LS → FileWrite → FileEdit → FileRead → end_turn），
 * 验证：每轮 tool_result 正确、文件系统终态正确、工具名 PascalCase、最终 assistant
 * 文本正确。
 *
 * 辅助场景：Bash / Grep / Glob 各做 1 个独立单轮用例，确保 7 个工具都至少被
 * agent loop 真实触达过一次。
 *
 * Mock LLM 风格：复用 query.test.ts 的 fake Anthropic Client（脚本化 turn 序列），
 * 不起 HTTP 服务器，速度快且无端口竞争。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  Message as SdkMessage,
} from "@anthropic-ai/sdk/resources/messages";
import type { ResolvedConfig } from "./config/config.ts";
import { runAgentLoop } from "./QueryEngine.ts";
import { builtinTools } from "./tools.ts";
import { type AgentEvent, AgentStopReasonEnum } from "./types/message.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fake SDK Client（与 query.test.ts 的 makeFakeClient 同构，本地复制以保持
// 集成测试自包含；如未来 fake client 抽到 test-helpers，可统一引用）
// ────────────────────────────────────────────────────────────────────────────

/** 单轮模拟响应。 */
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
      stream: (body: {
        model: string;
        messages: readonly unknown[];
        tools?: readonly unknown[];
      }) => {
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
  for (const chunk of turn.textChunks) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    } as RawMessageStreamEvent);
  }

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
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const baseConfig: ResolvedConfig = {
  apiKey: "sk-test",
  baseURL: undefined,
  model: "claude-test",
  maxTokens: 1024,
  // 5 轮足够覆盖最长场景（4 轮工具调用 + 1 轮 end_turn）
  maxTurns: 5,
  webProxy: undefined,
  webProxyDomains: [],
  mcpServers: {},
  hooks: {},
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-integration-"));
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function collectEvents(
  generator: AsyncGenerator<AgentEvent, unknown, void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

/** 收集所有 tool_result 事件。 */
function collectToolResults(
  events: readonly AgentEvent[],
): Array<Extract<AgentEvent, { type: "tool_result" }>> {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
  );
}

/** 收集所有 tool_call 事件。 */
function collectToolCalls(
  events: readonly AgentEvent[],
): Array<Extract<AgentEvent, { type: "tool_call" }>> {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
}

/** 拼接所有 text_delta 内容。 */
function joinTextDeltas(events: readonly AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ────────────────────────────────────────────────────────────────────────────
// 主场景：4 轮 edit-loop
// ────────────────────────────────────────────────────────────────────────────

describe("integration · 4-turn edit loop (LS → FileWrite → FileEdit → FileRead)", () => {
  test("end-to-end: agent uses 4 tools to create, edit, and verify a file", async () => {
    const targetFile = join(workDir, "hello.ts");

    const { client, calls } = makeFakeClient([
      // Turn 1: LS 列出空工作区
      {
        textChunks: ["Let me check the workspace first."],
        toolUses: [{ id: "tu_1", name: "LS", input: { path: workDir } }],
        stopReason: "tool_use",
      },
      // Turn 2: FileWrite 创建 hello.ts（必需字段：path + content）
      {
        textChunks: ["Workspace is empty. Creating hello.ts..."],
        toolUses: [
          {
            id: "tu_2",
            name: "FileWrite",
            input: {
              path: targetFile,
              content: "export const greeting = 'hello';\n",
            },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 3: FileEdit 把 'hello' 改成 'world'（必需字段：path + old_string + new_string）
      {
        textChunks: ["Now editing greeting from 'hello' to 'world'..."],
        toolUses: [
          {
            id: "tu_3",
            name: "FileEdit",
            input: {
              path: targetFile,
              old_string: "'hello'",
              new_string: "'world'",
            },
          },
        ],
        stopReason: "tool_use",
      },
      // Turn 4: FileRead 验证修改结果（必需字段：path）
      {
        textChunks: ["Verifying the change..."],
        toolUses: [{ id: "tu_4", name: "FileRead", input: { path: targetFile } }],
        stopReason: "tool_use",
      },
      // Turn 5: end_turn，宣布完成
      {
        textChunks: ["Done. The greeting is now 'world'."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "Create hello.ts with greeting='hello' then change it to 'world'",
        tools: builtinTools,
        client,
      }),
    );

    // ── 调用次数与对话历史增长 ──────────────────────────────────────────
    expect(calls.length).toBe(5);
    // 第二轮起，messages 历史每轮增长 2 条（assistant + tool_result-as-user）
    expect(calls[0]?.messageCount).toBe(1);
    expect(calls[1]?.messageCount).toBe(3);
    expect(calls[2]?.messageCount).toBe(5);
    expect(calls[3]?.messageCount).toBe(7);
    expect(calls[4]?.messageCount).toBe(9);
    // 每轮都应该带工具列表（builtinTools 非空）
    for (const call of calls) {
      expect(call.hasTools).toBe(true);
    }

    // ── 工具调用顺序与名字（PascalCase 对齐） ────────────────────────
    const toolCalls = collectToolCalls(events);
    expect(toolCalls.map((t) => t.toolName)).toEqual(["LS", "FileWrite", "FileEdit", "FileRead"]);

    // ── 每轮 tool_result 都成功 ─────────────────────────────────────
    const toolResults = collectToolResults(events);
    expect(toolResults.length).toBe(4);
    for (const r of toolResults) {
      expect(r.isError).toBe(false);
    }

    // Turn 1 LS：输出形如 "Directory: <abs>\n"。空目录时仅有 header 一行
    expect(toolResults[0]?.content).toContain("Directory:");
    expect(toolResults[0]?.content).toContain(workDir);
    // 空目录 → header 之后没有任何 entry 行
    expect(toolResults[0]?.content?.split("\n").length).toBe(1);

    // Turn 2 FileWrite：输出形如 "Created <path> (N bytes, M lines)"
    expect(toolResults[1]?.content).toContain("Created");
    expect(toolResults[1]?.content).toContain("hello.ts");
    expect(toolResults[1]?.content).toMatch(/lines?\)/);

    // Turn 3 FileEdit：成功且 diff 含 'hello' / 'world'
    expect(toolResults[2]?.content).toContain("hello.ts");
    expect(toolResults[2]?.content).toContain("hello");
    expect(toolResults[2]?.content).toContain("world");

    // Turn 4 FileRead：返回修改后的最新内容
    expect(toolResults[3]?.content).toContain("'world'");
    expect(toolResults[3]?.content).not.toContain("'hello'");

    // ── 文件系统终态：实际文件被正确改写 ─────────────────────────────
    const finalContent = await readFile(targetFile, "utf8");
    expect(finalContent).toBe("export const greeting = 'world';\n");

    // ── 最终 assistant 文本 ─────────────────────────────────────────
    const allText = joinTextDeltas(events);
    expect(allText).toContain("Done");
    expect(allText).toContain("'world'");

    // ── 终止原因 ────────────────────────────────────────────────────
    const finalTurnEnd = events
      .filter((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end")
      .at(-1);
    expect(finalTurnEnd?.stopReason).toBe(AgentStopReasonEnum.END_TURN);
    expect(events.at(-1)?.type).toBe("done");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 辅助场景：Bash / Grep / Glob 单轮覆盖
// ────────────────────────────────────────────────────────────────────────────

describe("integration · single-turn coverage for Bash/Grep/Glob", () => {
  test("Bash: agent runs `echo hello` and reports the output", async () => {
    const { client } = makeFakeClient([
      {
        textChunks: ["Running echo..."],
        toolUses: [
          {
            id: "tu_1",
            name: "Bash",
            input: { command: "echo hello", cwd: workDir },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Output was 'hello'."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "echo hello",
        tools: builtinTools,
        client,
      }),
    );

    const toolResults = collectToolResults(events);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.isError).toBe(false);
    // BashTool 输出格式包含 stdout/stderr/exit 等结构化段（详见 BashTool §4.1）
    expect(toolResults[0]?.content).toContain("hello");
    expect(toolResults[0]?.content).toMatch(/exit|stdout/i);
  });

  test("Grep: agent searches for pattern across workspace", async () => {
    // 准备：工作区里写两个文件，一个含 NEEDLE 一个不含
    await Bun.write(join(workDir, "a.ts"), "// NEEDLE here\nconst x = 1;\n");
    await Bun.write(join(workDir, "b.ts"), "// no match\nconst y = 2;\n");

    const { client } = makeFakeClient([
      {
        textChunks: ["Searching..."],
        toolUses: [
          {
            id: "tu_1",
            name: "Grep",
            input: { pattern: "NEEDLE", path: workDir },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Found 1 match in a.ts."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "find NEEDLE",
        tools: builtinTools,
        client,
      }),
    );

    const toolResults = collectToolResults(events);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.isError).toBe(false);
    expect(toolResults[0]?.content).toContain("a.ts");
    expect(toolResults[0]?.content).toContain("NEEDLE");
    expect(toolResults[0]?.content).not.toContain("b.ts");
  });

  test("Glob: agent lists files by pattern", async () => {
    await Bun.write(join(workDir, "a.ts"), "x");
    await Bun.write(join(workDir, "b.ts"), "x");
    await Bun.write(join(workDir, "c.md"), "x");

    const { client } = makeFakeClient([
      {
        textChunks: ["Listing ts files..."],
        toolUses: [
          {
            id: "tu_1",
            name: "Glob",
            input: { pattern: "*.ts", cwd: workDir },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Found 2 ts files."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "list ts",
        tools: builtinTools,
        client,
      }),
    );

    const toolResults = collectToolResults(events);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.isError).toBe(false);
    expect(toolResults[0]?.content).toContain("a.ts");
    expect(toolResults[0]?.content).toContain("b.ts");
    expect(toolResults[0]?.content).not.toContain("c.md");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 失败传播：工具入参非法 → tool_result.is_error=true → loop 继续
// ────────────────────────────────────────────────────────────────────────────

describe("integration · tool error propagation", () => {
  test("FileWrite to existing file → is_error=true → agent recovers in next turn", async () => {
    const targetFile = join(workDir, "exists.ts");
    await Bun.write(targetFile, "already here\n");

    const { client } = makeFakeClient([
      {
        textChunks: ["Creating file..."],
        toolUses: [
          {
            id: "tu_1",
            name: "FileWrite",
            input: { path: targetFile, content: "new content" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["I see, the file already exists. Aborting."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "create exists.ts",
        tools: builtinTools,
        client,
      }),
    );

    const toolResults = collectToolResults(events);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.isError).toBe(true);
    // 错误消息提示文件已存在
    expect(toolResults[0]?.content).toMatch(/exist|already/i);

    // 文件系统未被改动（仍是原内容）
    const finalContent = await readFile(targetFile, "utf8");
    expect(finalContent).toBe("already here\n");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M6 TodoWrite：复杂任务先规划，再继续执行
// ────────────────────────────────────────────────────────────────────────────

describe("integration · TodoWrite", () => {
  test("agent can create an in-memory todo list before a multi-step task", async () => {
    const { client, calls } = makeFakeClient([
      {
        textChunks: ["Planning first..."],
        toolUses: [
          {
            id: "tu_todo",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Inspect project structure",
                  activeForm: "Inspecting project structure",
                  status: "completed",
                },
                {
                  content: "Implement changes across files",
                  activeForm: "Implementing changes across files",
                  status: "in_progress",
                },
                {
                  content: "Run verification",
                  activeForm: "Running verification",
                  status: "pending",
                },
              ],
            },
          },
        ],
        stopReason: "tool_use",
      },
      {
        textChunks: ["Todo list is ready."],
        stopReason: "end_turn",
      },
    ]);

    const events = await collectEvents(
      runAgentLoop({
        config: baseConfig,
        userPrompt: "Plan a cross-file implementation",
        tools: builtinTools,
        client,
      }),
    );

    expect(calls.length).toBe(2);
    const toolCalls = collectToolCalls(events);
    expect(toolCalls.map((t) => t.toolName)).toEqual(["TodoWrite"]);

    const toolResults = collectToolResults(events);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.isError).toBe(false);
    expect(toolResults[0]?.content).toContain("Current todos:");
    expect(toolResults[0]?.content).toContain("[*] 2. Implementing changes across files");
    expect(toolResults[0]?.content).toContain("[ ] 3. Run verification");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// m1-5-e2e-writeflow：真子进程 + 本地 mock LLM 的写权完整链路验证
//
// 与上面走 fake client 的测试不同：这组用真的 Bun.spawn bin/nova-code.ts ask，
// 但通过 NOVA_TRANSPORT=mock 把 LLM 端切换成进程内假实现，覆盖：
// 配置加载 → Agent Loop → 7 个内置工具之一链的完整端到端流。
// ───────────────────────────────────────────────────────────────────────────

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

describe("m1-5-e2e-writeflow", () => {
  test("real child process + mock LLM: Grep → FileEdit → Bash → end_turn renames oldFn to newFn", async () => {
    const aPath = join(workDir, "a.ts");
    const bPath = join(workDir, "b.ts");
    const cPath = join(workDir, "c.ts");
    const childHome = join(workDir, "home");
    await mkdir(childHome, { recursive: true });
    await Bun.write(aPath, "export function oldFn() { return 1; }\n");
    await Bun.write(bPath, "// TODO: also rename oldFn here one day\n");
    await Bun.write(cPath, "// oldFn appears in comment too\n");

    const proc = Bun.spawn({
      cmd: ["bun", BIN_PATH, "ask", "rename oldFn to newFn"],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: childHome,
        USERPROFILE: childHome,
        NOVA_API_KEY: "sk-mock-anything",
        NOVA_TRANSPORT: "mock",
        NOVA_MOCK_SCENARIO: "edit-loop",
        MOCK_EDIT_WORKDIR: workDir,
        NOVA_WEB_PROXY: "",
        NOVA_WEB_PROXY_DOMAINS: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutHandle = setTimeout(() => proc.kill(), 10_000);
    const exitCode = await proc.exited;
    clearTimeout(timeoutHandle);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode, `non-zero exit.\nstdout=${stdout}\nstderr=${stderr}`).toBe(0);
    expect(stdout).toContain("Done");

    const aFinal = await readFile(aPath, "utf8");
    expect(aFinal).toBe("export function newFn() { return 1; }\n");

    const bFinal = await readFile(bPath, "utf8");
    const cFinal = await readFile(cPath, "utf8");
    expect(bFinal).toContain("oldFn");
    expect(cFinal).toContain("oldFn");
  }, 15_000);
});
