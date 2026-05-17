import type Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  Message as SdkMessage,
} from "@anthropic-ai/sdk/resources/messages";

export type MockScenario =
  | "chat"
  | "edit-loop"
  | "todo-loop"
  | "web-loop"
  | "mcp-loop"
  | "skill-loop"
  | "agent-loop";

interface MockAnthropicClientOptions {
  readonly scenario: MockScenario;
  readonly logFile?: string;
}

interface MockStream {
  [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent>;
  finalMessage(): Promise<SdkMessage>;
}

interface MockRequestBody {
  readonly messages: readonly Readonly<{
    readonly role?: string;
    readonly content: unknown;
  }>[];
  /** M4: 用于验证 forked-agent compact 请求复用主循环 tools。 */
  readonly tools?: unknown;
  /** M4: compact 请求应设置 tool_choice:none，强制纯文本 summary。 */
  readonly tool_choice?: unknown;
  /** M4: 用于把 CLAUDE.md 注入情况写到 mock log。 */
  readonly system?: unknown;
}

interface MockTurnPlan {
  readonly leadingText: string;
  readonly stopReason: SdkMessage["stop_reason"];
  readonly content: SdkMessage["content"];
  /** M4: 可选地覆盖响应 usage（用于 e2e 触发 autoCompact 阈值）。 */
  readonly usageOverride?: { readonly input_tokens: number; readonly output_tokens: number };
}

export function createMockAnthropicClient(options: MockAnthropicClientOptions): Anthropic {
  return {
    messages: {
      stream: (body: unknown): MockStream => {
        const request = body as MockRequestBody;
        const logPromise = appendRequestLog(options.logFile, request);
        const turn = buildTurn(options.scenario, request);
        return makeMockStream(turn, logPromise);
      },
    },
  } as Anthropic;
}

async function appendRequestLog(logFile: string | undefined, body: MockRequestBody): Promise<void> {
  if (logFile === undefined) return;
  const entry = {
    messageCount: body.messages.length,
    lastUserText: extractLastUserText(body.messages),
    // M4: 把 tools/tool_choice/system 落盘，给 e2e 断言 forked-agent cache 共享。
    hasTools: body.tools !== undefined,
    toolChoiceType: extractToolChoiceType(body.tool_choice),
    systemSnippet: extractSystemSnippet(body.system),
    toolResultText: extractLastToolResultText(body.messages),
  };
  const existing = await readLogFileText(logFile);
  await Bun.write(logFile, `${existing}${JSON.stringify(entry)}\n`);
}

/**
 * M4: 检测 compact 请求。
 * forked-agent 对齐后 compact 会带主循环同款 tools，因此只能用 prompt 特征识别。
 */
function isCompactRequest(body: MockRequestBody): boolean {
  const lastUserText = extractLastUserText(body.messages);
  return lastUserText?.includes("Your task is to create a detailed summary") === true;
}

function isSubAgentRequest(body: MockRequestBody): boolean {
  const system = extractSystemSnippet(body.system);
  const lastUserText = extractLastUserText(body.messages);
  return (
    system?.includes("sub-agent spawned by a parent coding assistant") === true ||
    lastUserText?.includes("<subagent_task>") === true
  );
}

function buildTurn(scenario: MockScenario, body: MockRequestBody): MockTurnPlan {
  // M4: compact 请求一律返回 summary（不论 scenario）
  if (isCompactRequest(body)) {
    return {
      leadingText: "",
      stopReason: "end_turn",
      content: makeTextContent("<summary>conversation compacted by mock</summary>"),
    };
  }

  if (isSubAgentRequest(body)) {
    return {
      leadingText: "Sub-agent inspected the delegated task.",
      stopReason: "end_turn",
      content: makeTextContent("Sub-agent inspected the delegated task."),
    };
  }

  if (scenario === "chat") {
    // M4: 可被 NOVA_MOCK_INFLATE_USAGE=<num> 强制把 usage.input_tokens 拉到指定值
    // 用来触发 autoCompact 阈值。不设/为 0 时按原 1/1 返回。
    const inflate = parseInt(process.env["NOVA_MOCK_INFLATE_USAGE"] ?? "0", 10);
    const usageOverride =
      Number.isFinite(inflate) && inflate > 0
        ? { input_tokens: inflate, output_tokens: 1 }
        : undefined;
    return {
      leadingText: "ok",
      stopReason: "end_turn",
      content: makeTextContent("ok"),
      ...(usageOverride !== undefined ? { usageOverride } : {}),
    };
  }

  if (scenario === "todo-loop") {
    return buildTodoLoopTurn(body);
  }

  if (scenario === "web-loop") {
    return buildWebLoopTurn(body);
  }

  if (scenario === "mcp-loop") {
    return buildMcpLoopTurn(body);
  }

  if (scenario === "skill-loop") {
    return buildSkillLoopTurn(body);
  }

  if (scenario === "agent-loop") {
    return buildAgentLoopTurn(body);
  }

  return buildEditLoopTurn(body);
}

function buildAgentLoopTurn(body: MockRequestBody): MockTurnPlan {
  const resultCount = countToolResults(body.messages);
  if (resultCount === 0) {
    return {
      leadingText: "Delegating to sub-agent...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Delegating to sub-agent..."),
        makeToolUseContent("toolu_agent_01", "Agent", {
          description: "Inspect delegated task",
          prompt: "Inspect the delegated task and return a concise summary.",
          subagent_type: "explore",
        }),
      ],
    };
  }

  return {
    leadingText: "Done. Agent completed.",
    stopReason: "end_turn",
    content: makeTextContent("Done. Agent completed."),
  };
}

function buildSkillLoopTurn(body: MockRequestBody): MockTurnPlan {
  const resultCount = countToolResults(body.messages);
  if (resultCount === 0) {
    return {
      leadingText: "Loading skill...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Loading skill..."),
        makeToolUseContent("toolu_skill_01", "Skill", { skill: "java" }),
      ],
    };
  }

  return {
    leadingText: "Done. Skill loaded.",
    stopReason: "end_turn",
    content: makeTextContent("Done. Skill loaded."),
  };
}

function buildMcpLoopTurn(body: MockRequestBody): MockTurnPlan {
  const resultCount = countToolResults(body.messages);
  const toolName = process.env["MOCK_MCP_TOOL_NAME"] ?? "MCP__test__echo";
  if (resultCount === 0) {
    return {
      leadingText: "Calling MCP tool...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Calling MCP tool..."),
        makeToolUseContent("toolu_mcp_01", toolName, {
          message: "hello from nova-code",
        }),
      ],
    };
  }

  return {
    leadingText: "Done. MCP tool completed.",
    stopReason: "end_turn",
    content: makeTextContent("Done. MCP tool completed."),
  };
}

function buildWebLoopTurn(body: MockRequestBody): MockTurnPlan {
  const resultCount = countToolResults(body.messages);
  const url = process.env["MOCK_WEB_URL"] ?? "http://127.0.0.1:9/missing";
  if (resultCount === 0) {
    return {
      leadingText: "Fetching the target page...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Fetching the target page..."),
        makeToolUseContent("toolu_web_01", "WebFetch", {
          url,
          prompt: "Extract the page summary",
        }),
      ],
    };
  }
  if (resultCount === 1) {
    return {
      leadingText: "Searching the web...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Searching the web..."),
        makeToolUseContent("toolu_web_02", "WebSearch", {
          query: "nova code web tools",
        }),
      ],
    };
  }

  return {
    leadingText: "Done. Web tools completed.",
    stopReason: "end_turn",
    content: makeTextContent("Done. Web tools completed."),
  };
}

function buildTodoLoopTurn(body: MockRequestBody): MockTurnPlan {
  const resultCount = countToolResults(body.messages);
  if (resultCount === 0) {
    return {
      leadingText: "Planning the multi-step task...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Planning the multi-step task..."),
        makeToolUseContent("toolu_todo_01", "TodoWrite", {
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
        }),
      ],
    };
  }

  return {
    leadingText: "Done. TodoWrite tracked the multi-step task.",
    stopReason: "end_turn",
    content: makeTextContent("Done. TodoWrite tracked the multi-step task."),
  };
}

function buildEditLoopTurn(body: MockRequestBody): MockTurnPlan {
  const workDir = process.env["MOCK_EDIT_WORKDIR"] ?? ".";
  const resultCount = countToolResults(body.messages);
  if (resultCount === 0) {
    return {
      leadingText: "Searching for oldFn...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Searching for oldFn..."),
        makeToolUseContent("toolu_edit_01", "Grep", { pattern: "oldFn", path: workDir }),
      ],
    };
  }
  if (resultCount === 1) {
    return {
      leadingText: "Renaming oldFn to newFn in a.ts...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Renaming oldFn to newFn in a.ts..."),
        makeToolUseContent("toolu_edit_02", "FileEdit", {
          path: `${workDir}/a.ts`,
          old_string: "oldFn",
          new_string: "newFn",
        }),
      ],
    };
  }
  if (resultCount === 2) {
    return {
      leadingText: "Verifying with echo...",
      stopReason: "tool_use",
      content: [
        ...makeTextContent("Verifying with echo..."),
        makeToolUseContent("toolu_edit_03", "Bash", { command: "echo done", cwd: workDir }),
      ],
    };
  }

  return {
    leadingText: "Done. Renamed oldFn to newFn in a.ts.",
    stopReason: "end_turn",
    content: makeTextContent("Done. Renamed oldFn to newFn in a.ts."),
  };
}

function countToolResults(messages: MockRequestBody["messages"]): number {
  let count = 0;
  for (const message of messages) {
    if (containsToolResult(message.content)) {
      count += 1;
    }
  }
  return count;
}

function containsToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isObject(block) && block["type"] === "tool_result");
}

function extractLastUserText(messages: MockRequestBody["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    if (typeof message.content !== "string") return undefined;
    return message.content;
  }
  return undefined;
}

function extractLastToolResultText(messages: MockRequestBody["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || !Array.isArray(message.content)) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (!isObject(block) || block["type"] !== "tool_result") continue;
      return typeof block["content"] === "string" ? block["content"] : undefined;
    }
  }
  return undefined;
}

/**
 * M4: 把 system 字段抽前 500 字符放到 mock log，供 e2e 断言 CLAUDE.md 是否注入。
 */
function extractSystemSnippet(system: unknown): string | undefined {
  // 给上限一点余量；CLAUDE.md 4 层 + @include 时 parent 内容靠后，需要够长才捕得到
  const MAX = 4000;
  if (typeof system === "string") return system.slice(0, MAX);
  if (Array.isArray(system)) {
    const first = system[0];
    if (isObject(first) && typeof first["text"] === "string") {
      return (first["text"] as string).slice(0, MAX);
    }
  }
  return undefined;
}

function extractToolChoiceType(toolChoice: unknown): string | undefined {
  if (isObject(toolChoice) && typeof toolChoice["type"] === "string") {
    return toolChoice["type"];
  }
  return undefined;
}

async function readLogFileText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

function makeMockStream(turn: MockTurnPlan, logPromise: Promise<void>): MockStream {
  // M4: 允许 turn.usageOverride 强制响应 usage（用于 autoCompact 阈值触发）
  const usage = (turn.usageOverride ?? {
    input_tokens: 1,
    output_tokens: 1,
  }) as SdkMessage["usage"];
  const finalMessage: SdkMessage = {
    id: "msg_mock",
    container: null,
    type: "message",
    role: "assistant",
    content: turn.content,
    model: "claude-mock",
    stop_details: null,
    stop_reason: turn.stopReason,
    stop_sequence: null,
    usage,
  };

  const events: RawMessageStreamEvent[] = [];
  if (turn.leadingText !== "") {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: turn.leadingText },
    } as RawMessageStreamEvent);
  }

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<RawMessageStreamEvent> {
      for (const event of events) {
        yield event;
      }
    },
    async finalMessage(): Promise<SdkMessage> {
      await logPromise;
      return finalMessage;
    },
  };
}

function makeTextContent(text: string): SdkMessage["content"] {
  return [{ type: "text", text, citations: null }];
}

function makeToolUseContent(
  id: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
): SdkMessage["content"][number] {
  return {
    type: "tool_use",
    id,
    name,
    input,
  } as SdkMessage["content"][number];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
