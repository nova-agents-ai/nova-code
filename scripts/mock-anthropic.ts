/**
 * Anthropic Messages API 的最小本地 mock。
 *
 * 用途：
 *   开发/调试 nova-code 的 LLM 模块时，无需真实 API key、无需外网，
 *   只要把 NOVA_BASE_URL 指向本机即可让 ask 命令完整跑通 agent loop。
 *
 * 用法：
 *   bun run scripts/mock-anthropic.ts                       # 默认端口 8787
 *   PORT=9000 bun run scripts/mock-anthropic.ts             # 换端口
 *   或： bun run mock                                       # 见 package.json
 *
 *   另起终端：
 *   NOVA_API_KEY=anything NOVA_BASE_URL=http://localhost:8787 \
 *     bun run start -- ask --debug "hi"
 *
 * 行为：
 *   - 收到 POST /v1/messages 时返回 SSE 流，覆盖 anthropic SDK 的事件契约
 *   - 通过 query 参数 scenario 选择剧本：
 *       ?scenario=simple  （默认）单轮 end_turn，模型只回一句话
 *       ?scenario=tool    第一次返回 tool_use（list_dir），收到 tool_result 后
 *                         第二次返回 end_turn 文本
 *   - 通过对话历史中是否已出现 user/tool_result 自动判断"是不是第二轮请求"，
 *     无需调用方显式切换 scenario
 *
 * 故意不实现的：
 *   - 鉴权（任何 x-api-key 都接受）
 *   - rate limit / token usage 真实统计（usage 字段固定值）
 *   - 多模态 / image / pdf
 *   - 非流式（messages.create 不带 stream:true）请求 —— SDK 的 messages.stream
 *     调用一定会 stream，nova-code 也只用 stream 路径
 */

import type { Server } from "bun";

/** SSE 事件流中每条事件的最小形状。 */
interface SseEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Anthropic /v1/messages 请求体里我们关心的子集。 */
interface MessagesRequestBody {
  readonly model?: string;
  readonly messages: readonly Readonly<{
    readonly role: "user" | "assistant";
    readonly content: unknown;
  }>[];
}

/** mock 支持的剧本枚举。 */
enum ScenarioEnum {
  SIMPLE = "simple",
  TOOL = "tool",
}

const DEFAULT_PORT = 8787;
const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

const portFromEnv = process.env["PORT"];
const port = portFromEnv === undefined ? DEFAULT_PORT : Number.parseInt(portFromEnv, 10);
if (Number.isNaN(port) || port <= 0) {
  console.error(`[mock-anthropic] invalid PORT: ${portFromEnv}`);
  process.exit(1);
}

const server: Server = Bun.serve({
  port,
  fetch: handleRequest,
});

console.log(`[mock-anthropic] listening on http://localhost:${server.port}`);
console.log("[mock-anthropic] try:");
console.log(
  `  NOVA_API_KEY=anything NOVA_BASE_URL=http://localhost:${server.port} bun run start -- ask --debug "hi"`,
);
console.log(
  `  NOVA_API_KEY=anything NOVA_BASE_URL=http://localhost:${server.port}/?scenario=tool bun run start -- ask --debug "list ts files"`,
);

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // 兼容两种调用方式：
  //   NOVA_BASE_URL=http://localhost:8787              → SDK 拼出 /v1/messages
  //   NOVA_BASE_URL=http://localhost:8787/?scenario=x  → SDK 拼出 /v1/messages?scenario=x
  // 也兼容用户手写的 /?scenario=x 这类裸根路径（pathname=/，把 scenario 透传给 mock）
  const isMessagesEndpoint =
    url.pathname.endsWith("/v1/messages") || url.pathname === "/" || url.pathname === "";
  if (request.method !== "POST" || !isMessagesEndpoint) {
    return new Response(
      JSON.stringify({ error: "mock only handles POST /v1/messages" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  let body: MessagesRequestBody;
  try {
    body = (await request.json()) as MessagesRequestBody;
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `invalid JSON body: ${describeError(error)}` }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const scenario = parseScenario(url.searchParams.get("scenario"));
  const events = buildScenarioEvents(scenario, body);

  console.log(
    `[mock-anthropic] ${request.method} ${url.pathname}${url.search} ` +
      `scenario=${scenario} messages=${body.messages.length} ` +
      `→ ${events.length} sse events`,
  );

  return new Response(serializeSseStream(events), {
    status: 200,
    headers: SSE_HEADERS,
  });
}

/** 把 ?scenario=xxx 收窄到合法枚举，缺省/非法都落到 SIMPLE。 */
function parseScenario(raw: string | null): ScenarioEnum {
  if (raw === ScenarioEnum.TOOL) return ScenarioEnum.TOOL;
  return ScenarioEnum.SIMPLE;
}

/**
 * 根据剧本 + 当前对话历史构造一组 SSE 事件。
 *
 * SIMPLE：永远返回一句固定文本，stop_reason=end_turn。
 *
 * TOOL：通过对话历史里是否已经包含 tool_result 来判定第几轮。
 *   - 第一轮：返回一段引言文本 + 一个 tool_use(list_dir)，stop_reason=tool_use
 *   - 第二轮（已经看到 tool_result）：返回最终回答，stop_reason=end_turn
 */
function buildScenarioEvents(
  scenario: ScenarioEnum,
  body: MessagesRequestBody,
): readonly SseEvent[] {
  if (scenario === ScenarioEnum.SIMPLE) {
    return composeTextOnlyTurn("hello from mock-anthropic");
  }

  const alreadyHasToolResult = body.messages.some((message) => containsToolResult(message.content));
  if (!alreadyHasToolResult) {
    return composeToolUseTurn({
      leadingText: "Let me list the directory first.",
      toolUseId: "toolu_mock_01",
      toolName: "list_dir",
      input: { path: "." },
    });
  }
  return composeTextOnlyTurn("Found 2 files: a.ts, b.ts");
}

/** 判断某条 message.content 中是否包含 tool_result 块。 */
function containsToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isObject(block) && block["type"] === "tool_result");
}

/** 一轮纯文本回答的 SSE 事件序列。 */
function composeTextOnlyTurn(text: string): readonly SseEvent[] {
  return [
    messageStartEvent(),
    contentBlockStartEvent({ index: 0, block: { type: "text", text: "" } }),
    contentBlockDeltaEvent({ index: 0, delta: { type: "text_delta", text } }),
    contentBlockStopEvent(0),
    messageDeltaEvent("end_turn"),
    messageStopEvent(),
  ];
}

interface ToolUseTurnArgs {
  readonly leadingText: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** 一轮 "文本引言 + 一次 tool_use" 的 SSE 事件序列。 */
function composeToolUseTurn(args: ToolUseTurnArgs): readonly SseEvent[] {
  const inputJson = JSON.stringify(args.input);
  return [
    messageStartEvent(),
    // 第 0 块：引言文本
    contentBlockStartEvent({ index: 0, block: { type: "text", text: "" } }),
    contentBlockDeltaEvent({
      index: 0,
      delta: { type: "text_delta", text: args.leadingText },
    }),
    contentBlockStopEvent(0),
    // 第 1 块：tool_use
    contentBlockStartEvent({
      index: 1,
      block: {
        type: "tool_use",
        id: args.toolUseId,
        name: args.toolName,
        input: {},
      },
    }),
    // SDK 期望 input 通过 input_json_delta 流式拼接
    contentBlockDeltaEvent({
      index: 1,
      delta: { type: "input_json_delta", partial_json: inputJson },
    }),
    contentBlockStopEvent(1),
    messageDeltaEvent("tool_use"),
    messageStopEvent(),
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// SSE 事件构造工厂（与 Anthropic stream 协议对齐）
// ────────────────────────────────────────────────────────────────────────────

const FIXED_USAGE = { input_tokens: 1, output_tokens: 1 } as const;

function messageStartEvent(): SseEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_mock_001",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-mock",
        stop_reason: null,
        stop_sequence: null,
        usage: FIXED_USAGE,
      },
    },
  };
}

interface ContentBlockStartArgs {
  readonly index: number;
  readonly block: Readonly<Record<string, unknown>>;
}

function contentBlockStartEvent(args: ContentBlockStartArgs): SseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: args.index,
      content_block: args.block,
    },
  };
}

interface ContentBlockDeltaArgs {
  readonly index: number;
  readonly delta: Readonly<Record<string, unknown>>;
}

function contentBlockDeltaEvent(args: ContentBlockDeltaArgs): SseEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: args.index,
      delta: args.delta,
    },
  };
}

function contentBlockStopEvent(index: number): SseEvent {
  return {
    event: "content_block_stop",
    data: { type: "content_block_stop", index },
  };
}

function messageDeltaEvent(stopReason: string): SseEvent {
  return {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: FIXED_USAGE,
    },
  };
}

function messageStopEvent(): SseEvent {
  return {
    event: "message_stop",
    data: { type: "message_stop" },
  };
}

/**
 * 把事件数组序列化为标准 SSE 文本：
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 */
function serializeSseStream(events: readonly SseEvent[]): string {
  let buffer = "";
  for (const event of events) {
    buffer += `event: ${event.event}\n`;
    buffer += `data: ${JSON.stringify(event.data)}\n\n`;
  }
  return buffer;
}

// ────────────────────────────────────────────────────────────────────────────
// 通用工具
// ────────────────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
