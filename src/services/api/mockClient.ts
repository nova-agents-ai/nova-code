import type Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  Message as SdkMessage,
} from "@anthropic-ai/sdk/resources/messages";

type MockScenario = "chat" | "edit-loop";

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
}

interface MockTurnPlan {
  readonly leadingText: string;
  readonly stopReason: SdkMessage["stop_reason"];
  readonly content: SdkMessage["content"];
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
  };
  const existing = await readLogFileText(logFile);
  await Bun.write(logFile, `${existing}${JSON.stringify(entry)}\n`);
}

function buildTurn(scenario: MockScenario, body: MockRequestBody): MockTurnPlan {
  if (scenario === "chat") {
    return {
      leadingText: "ok",
      stopReason: "end_turn",
      content: makeTextContent("ok"),
    };
  }

  return buildEditLoopTurn(body);
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

async function readLogFileText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

function makeMockStream(turn: MockTurnPlan, logPromise: Promise<void>): MockStream {
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
    usage: { input_tokens: 1, output_tokens: 1 } as SdkMessage["usage"],
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
