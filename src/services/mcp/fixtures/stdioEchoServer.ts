/** Test MCP stdio server fixture used by M8 unit/e2e tests. */

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}

const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffer = "";

try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeLines(buffer);
  }
  buffer += decoder.decode();
  consumeLines(`${buffer}\n`);
} finally {
  reader.releaseLock();
}

function consumeLines(text: string): string {
  let start = 0;
  while (true) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) return text.slice(start);
    const line = text.slice(start, newline).trim();
    if (line !== "") handleLine(line);
    start = newline + 1;
  }
}

function handleLine(line: string): void {
  const parsed = JSON.parse(line) as JsonRpcRequest;
  if (parsed.method === "notifications/initialized") return;
  if (parsed.id === undefined) return;

  if (parsed.method === "initialize") {
    writeResult(parsed.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fixture-echo", version: "1.0.0" },
    });
    return;
  }

  if (parsed.method === "tools/list") {
    writeResult(parsed.id, {
      tools: [
        {
          name: "echo",
          description: "Echo a message through a fixture MCP server.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    return;
  }

  if (parsed.method === "tools/call") {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};
    const message = typeof args["message"] === "string" ? args["message"] : "";
    writeResult(parsed.id, {
      content: [{ type: "text", text: `echo:${message}` }],
      structuredContent: { echoed: message },
    });
    return;
  }

  writeError(parsed.id, -32601, `Method not found: ${String(parsed.method)}`);
}

function writeResult(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: number, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
