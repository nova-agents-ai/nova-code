import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpStreamableHttpClient } from "./McpStreamableHttpClient.ts";
import { MCP_TOOLS_LIST_CHANGED_NOTIFICATION } from "./types.ts";

interface HttpFixture {
  readonly url: string;
  readonly stop: () => void;
  readonly sendNotification: (method: string, params: unknown) => void;
  readonly hasSseClient: () => boolean;
  readonly toolListHits: () => number;
}

const encoder = new TextEncoder();
const ORIGINAL_MCP_TOKEN = process.env["MCP_TOKEN"];
let fixture: HttpFixture | undefined;
let clients: McpStreamableHttpClient[] = [];

beforeEach(() => {
  process.env["MCP_TOKEN"] = "secret-token";
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
  fixture?.stop();
  fixture = undefined;
  if (ORIGINAL_MCP_TOKEN === undefined) {
    delete process.env["MCP_TOKEN"];
  } else {
    process.env["MCP_TOKEN"] = ORIGINAL_MCP_TOKEN;
  }
});

describe("McpStreamableHttpClient", () => {
  test("initialize + tools/list + tools/call over Streamable HTTP JSON", async () => {
    fixture = startHttpFixture({ responseMode: "json" });
    const client = createClient(fixture.url);

    const initialized = await client.connect();
    expect(initialized.protocolVersion).toBe("2025-11-25");
    expect(initialized.serverInfo.name).toBe("fixture-http");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(fixture.toolListHits()).toBe(1);

    const called = await client.callTool("echo", { message: "hello" });
    expect(called.content[0]?.text).toBe("http-echo:hello");
  });

  test("reads JSON-RPC response from POST text/event-stream", async () => {
    fixture = startHttpFixture({ responseMode: "sse" });
    const client = createClient(fixture.url);
    await client.connect();

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  test("receives tools/list_changed notification from GET SSE", async () => {
    fixture = startHttpFixture({ responseMode: "json" });
    const client = createClient(fixture.url);
    const notifications: string[] = [];
    client.onNotification((method) => notifications.push(method));
    await client.connect();
    await waitFor(() => fixture?.hasSseClient() === true);

    fixture.sendNotification(MCP_TOOLS_LIST_CHANGED_NOTIFICATION, {});

    await waitFor(() => notifications.includes(MCP_TOOLS_LIST_CHANGED_NOTIFICATION));
  });
});

function createClient(url: string): McpStreamableHttpClient {
  const client = new McpStreamableHttpClient("fixture", {
    type: "http",
    url,
    headers: { Authorization: `Bearer \${MCP_TOKEN}` },
  });
  clients.push(client);
  return client;
}

function startHttpFixture(params: { readonly responseMode: "json" | "sse" }): HttpFixture {
  let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let toolListHits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sseController = controller;
            },
            cancel() {
              sseController = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (request.headers.get("Authorization") !== "Bearer secret-token") {
        return new Response("missing auth", { status: 401 });
      }
      const payload = (await request.json()) as Readonly<Record<string, unknown>>;
      const response = handleJsonRpcPayload(payload, () => {
        toolListHits += 1;
      });
      if (response === undefined) return new Response(null, { status: 202 });
      if (params.responseMode === "sse") return sseResponse(response);
      return jsonResponse(response);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
    sendNotification: (method, notificationParams) => {
      sseController?.enqueue(
        encoder.encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method, params: notificationParams })}\n\n`,
        ),
      );
    },
    hasSseClient: () => sseController !== undefined,
    toolListHits: () => toolListHits,
  };
}

function handleJsonRpcPayload(
  payload: Readonly<Record<string, unknown>>,
  onListTools: () => void,
): Readonly<Record<string, unknown>> | undefined {
  const id = payload["id"];
  const method = payload["method"];
  if (id === undefined) return undefined;
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "fixture-http", version: "1.0.0" },
    });
  }
  if (method === "tools/list") {
    onListTools();
    return rpcResult(id, { tools: [echoTool()] });
  }
  if (method === "tools/call") {
    const params = isRecord(payload["params"]) ? payload["params"] : {};
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};
    const message = typeof args["message"] === "string" ? args["message"] : "";
    return rpcResult(id, {
      content: [{ type: "text", text: `http-echo:${message}` }],
      structuredContent: { echoed: message },
    });
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

function echoTool(): Readonly<Record<string, unknown>> {
  return {
    name: "echo",
    description: "Echo over HTTP.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  };
}

function rpcResult(id: unknown, result: unknown): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, result };
}

function jsonResponse(payload: Readonly<Record<string, unknown>>): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (payload["id"] === 1) headers.set("MCP-Session-Id", "session-1");
  return new Response(JSON.stringify(payload), { headers });
}

function sseResponse(payload: Readonly<Record<string, unknown>>): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { "content-type": "text/event-stream", "MCP-Session-Id": "session-1" },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("condition not met before timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
