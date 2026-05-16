/** Minimal MCP Streamable HTTP client for tools/list and tools/call. */

import { buildExpandedHeaders } from "./environment.ts";
import {
  getErrorMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isRecord,
  type JsonRpcId,
  type JsonRpcRequestMessage,
  McpProtocolError,
  parseCallToolResult,
  parseInitializeResult,
  parseListToolsResult,
} from "./protocol.ts";
import type {
  McpCallToolResult,
  McpClient,
  McpInitializeResult,
  McpListToolsResult,
  McpNotificationListener,
  McpStreamableHttpServerConfig,
  McpToolDefinition,
} from "./types.ts";
import { MCP_PROTOCOL_VERSION } from "./types.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_NAME = "nova-code";
const CLIENT_VERSION = "0.8.0";
const ACCEPT_POST = "application/json, text/event-stream";
const ACCEPT_SSE = "text/event-stream";
const CONTENT_TYPE_JSON = "application/json";
const MCP_SESSION_ID_HEADER = "MCP-Session-Id";
const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
const MAX_HTTP_ERROR_BODY_CHARS = 2_000;

type RequestId = number;

interface SseEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
  readonly retryMs?: number;
}

interface RequestAbortScope {
  readonly signal: AbortSignal;
  readonly isTimedOut: () => boolean;
  readonly close: () => void;
}

interface IncomingRequestResult {
  readonly matched: boolean;
  readonly result?: unknown;
}

export class McpStreamableHttpClient implements McpClient {
  private readonly serverName: string;
  private readonly timeoutMs: number;
  private readonly endpointUrl: string;
  private readonly configuredHeaders: Readonly<Record<string, string>>;
  private readonly notificationListeners = new Set<McpNotificationListener>();
  private readonly sseAbortController = new AbortController();
  private nextId = 1;
  private closed = false;
  private initializeResult: McpInitializeResult | undefined;
  private sessionId: string | undefined;
  private negotiatedProtocolVersion: string | undefined;
  private sseTask: Promise<void> | undefined;
  private diagnostic = "";

  constructor(serverName: string, config: McpStreamableHttpServerConfig) {
    this.serverName = serverName;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.endpointUrl = config.url;
    this.configuredHeaders = buildExpandedHeaders(config.headers);
  }

  get serverInfo(): McpInitializeResult | undefined {
    return this.initializeResult;
  }

  get diagnosticSnippet(): string {
    return this.diagnostic;
  }

  onNotification(listener: McpNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async connect(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (this.initializeResult !== undefined) return this.initializeResult;
    const initialized = await this.initialize(signal);
    await this.notify("notifications/initialized", {}, signal);
    this.startSseListener();
    return initialized;
  }

  async listTools(signal?: AbortSignal): Promise<McpListToolsResult> {
    let cursor: string | undefined;
    const tools: McpToolDefinition[] = [];
    do {
      const result = await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        signal,
      );
      const page = parseListToolsResult(result, this.serverName);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor !== "");
    return { tools };
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    const result = await this.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      signal,
    );
    return parseCallToolResult(result, this.serverName, name);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sseAbortController.abort();
    const sessionId = this.sessionId;
    if (sessionId !== undefined) await this.deleteSessionBestEffort(sessionId);
    await Promise.allSettled([this.sseTask]);
  }

  private async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: CLIENT_NAME,
          version: CLIENT_VERSION,
        },
      },
      signal,
    );
    const initialized = parseInitializeResult(result, this.serverName);
    this.initializeResult = initialized;
    this.negotiatedProtocolVersion = initialized.protocolVersion;
    return initialized;
  }

  private async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new McpProtocolError(`MCP server '${this.serverName}' is closed.`);
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    const abortScope = createRequestAbortScope(signal, this.timeoutMs);
    try {
      const response = await this.postMessage(payload, abortScope.signal);
      if (method === "initialize") this.captureSessionId(response);
      return await this.readRequestResponse(response, id, method, abortScope.signal);
    } catch (error) {
      throw this.normalizeRequestError(error, method, abortScope, signal);
    } finally {
      abortScope.close();
    }
  }

  private async notify(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) return;
    const abortScope = createRequestAbortScope(signal, this.timeoutMs);
    try {
      const response = await this.postMessage(
        { jsonrpc: "2.0", method, params },
        abortScope.signal,
      );
      if (!response.ok) await this.throwHttpError(response, method);
      await response.body?.cancel();
    } catch (error) {
      throw this.normalizeRequestError(error, method, abortScope, signal);
    } finally {
      abortScope.close();
    }
  }

  private async postMessage(payload: unknown, signal: AbortSignal): Promise<Response> {
    return await fetch(this.endpointUrl, {
      method: "POST",
      headers: this.buildHeaders(ACCEPT_POST, true),
      body: JSON.stringify(payload),
      signal,
    });
  }

  private async readRequestResponse(
    response: Response,
    expectedId: RequestId,
    method: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!response.ok) await this.throwHttpError(response, method);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes(CONTENT_TYPE_JSON)) {
      return await this.readJsonResponse(response, expectedId, method);
    }
    if (contentType.includes(ACCEPT_SSE)) {
      return await this.readSseResponse(response, expectedId, method, signal);
    }
    throw new McpProtocolError(
      `MCP HTTP request '${method}' to '${this.serverName}' returned unsupported content-type '${contentType}'.`,
    );
  }

  private async readJsonResponse(
    response: Response,
    expectedId: RequestId,
    method: string,
  ): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new McpProtocolError(
        `MCP HTTP request '${method}' to '${this.serverName}' returned invalid JSON: ${getErrorMessage(error)}.`,
      );
    }
    const handled = await this.handleIncomingMessage(parsed, expectedId, method);
    if (handled?.matched === true) return handled.result;
    throw new McpProtocolError(
      `MCP HTTP request '${method}' to '${this.serverName}' did not return a matching JSON-RPC response.`,
    );
  }

  private async readSseResponse(
    response: Response,
    expectedId: RequestId,
    method: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const body = response.body;
    if (body === null) {
      throw new McpProtocolError(
        `MCP HTTP request '${method}' to '${this.serverName}' returned an empty SSE body.`,
      );
    }
    let result: unknown;
    let matched = false;
    await readSseStream(body, signal, async (event) => {
      if (event.data.trim() === "") return false;
      const parsed = parseSseJson(event.data, this.serverName);
      const handled = await this.handleIncomingMessage(parsed, expectedId, method);
      if (handled?.matched !== true) return false;
      result = handled.result;
      matched = true;
      return true;
    });
    if (matched) return result;
    throw new McpProtocolError(
      `MCP HTTP request '${method}' to '${this.serverName}' SSE stream ended without a matching response.`,
    );
  }

  private async handleIncomingMessage(
    message: unknown,
    expectedId?: JsonRpcId,
    method?: string,
  ): Promise<IncomingRequestResult | undefined> {
    if (!isRecord(message)) return undefined;
    if (isJsonRpcResponse(message)) {
      if (expectedId === undefined || message.id !== expectedId) return { matched: false };
      if (message.error !== undefined) {
        throw new McpProtocolError(
          `MCP request '${method ?? "unknown"}' to '${this.serverName}' failed: ${message.error.message}`,
        );
      }
      return { matched: true, result: message.result };
    }
    if (isJsonRpcRequest(message)) {
      await this.handleServerRequest(message);
      return undefined;
    }
    if (isJsonRpcNotification(message)) {
      this.emitNotification(message.method, message.params);
    }
    return undefined;
  }

  private async handleServerRequest(request: JsonRpcRequestMessage): Promise<void> {
    if (request.id === undefined) return;
    if (request.method === "ping") {
      await this.postResponse({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    await this.postResponse({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `Method not found: ${String(request.method)}`,
      },
    });
  }

  private async postResponse(payload: unknown): Promise<void> {
    if (this.closed) return;
    const abortScope = createRequestAbortScope(undefined, this.timeoutMs);
    try {
      const response = await this.postMessage(payload, abortScope.signal);
      if (!response.ok) await this.throwHttpError(response, "response");
      await response.body?.cancel();
    } finally {
      abortScope.close();
    }
  }

  private startSseListener(): void {
    if (this.sseTask !== undefined || this.closed) return;
    this.sseTask = this.listenForServerMessages().catch((error: unknown) => {
      if (this.closed) return;
      this.diagnostic = `SSE listener failed: ${getErrorMessage(error)}`;
    });
  }

  private async listenForServerMessages(): Promise<void> {
    const response = await fetch(this.endpointUrl, {
      method: "GET",
      headers: this.buildHeaders(ACCEPT_SSE, false),
      signal: this.sseAbortController.signal,
    });
    if (response.status === 405) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok) await this.throwHttpError(response, "GET");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes(ACCEPT_SSE)) {
      await response.body?.cancel();
      return;
    }
    const body = response.body;
    if (body === null) return;
    await readSseStream(body, this.sseAbortController.signal, async (event) => {
      if (event.data.trim() === "") return false;
      await this.handleIncomingMessage(parseSseJson(event.data, this.serverName));
      return false;
    });
  }

  private buildHeaders(accept: string, includeContentType: boolean): Headers {
    const headers = new Headers(this.configuredHeaders);
    headers.set("Accept", accept);
    if (includeContentType) headers.set("Content-Type", CONTENT_TYPE_JSON);
    headers.set(
      MCP_PROTOCOL_VERSION_HEADER,
      this.negotiatedProtocolVersion ?? MCP_PROTOCOL_VERSION,
    );
    if (this.sessionId !== undefined) headers.set(MCP_SESSION_ID_HEADER, this.sessionId);
    return headers;
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get(MCP_SESSION_ID_HEADER);
    if (sessionId !== null && sessionId !== "") this.sessionId = sessionId;
  }

  private emitNotification(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  private async deleteSessionBestEffort(sessionId: string): Promise<void> {
    const abortScope = createRequestAbortScope(undefined, this.timeoutMs);
    try {
      const headers = this.buildHeaders(ACCEPT_POST, false);
      headers.set(MCP_SESSION_ID_HEADER, sessionId);
      await fetch(this.endpointUrl, { method: "DELETE", headers, signal: abortScope.signal });
    } catch (_error) {
      // Session termination is best-effort per MCP Streamable HTTP.
    } finally {
      abortScope.close();
    }
  }

  private normalizeRequestError(
    error: unknown,
    method: string,
    abortScope: RequestAbortScope,
    parentSignal: AbortSignal | undefined,
  ): Error {
    if (abortScope.isTimedOut()) {
      return new McpProtocolError(
        `MCP HTTP request '${method}' to '${this.serverName}' timed out.`,
      );
    }
    if (parentSignal?.aborted === true)
      return new DOMException("The operation was aborted.", "AbortError");
    return error instanceof Error ? error : new Error(String(error));
  }

  private async throwHttpError(response: Response, method: string): Promise<never> {
    const body = await safeReadErrorBody(response);
    throw new McpProtocolError(
      `MCP HTTP request '${method}' to '${this.serverName}' failed with HTTP ${response.status}${body}`,
    );
  }
}

function createRequestAbortScope(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestAbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromParent = (): void => controller.abort();
  if (parentSignal?.aborted === true) controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    close: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => Promise<boolean>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buffer = normalizeSseBuffer(`${buffer}${decoder.decode(value, { stream: true })}`);
      const consumed = await consumeSseEvents(buffer, onEvent);
      buffer = consumed.remaining;
      if (consumed.shouldStop) {
        await reader.cancel();
        return;
      }
    }
    buffer = normalizeSseBuffer(`${buffer}${decoder.decode()}`);
    if (buffer.trim() !== "") {
      const event = parseSseEvent(buffer);
      if (event !== undefined) await onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}

async function consumeSseEvents(
  buffer: string,
  onEvent: (event: SseEvent) => Promise<boolean>,
): Promise<{ readonly remaining: string; readonly shouldStop: boolean }> {
  let remaining = buffer;
  while (true) {
    const delimiter = remaining.indexOf("\n\n");
    if (delimiter === -1) return { remaining, shouldStop: false };
    const rawEvent = remaining.slice(0, delimiter);
    remaining = remaining.slice(delimiter + 2);
    const event = parseSseEvent(rawEvent);
    if (event !== undefined && (await onEvent(event))) {
      return { remaining, shouldStop: true };
    }
  }
}

function parseSseEvent(rawEvent: string): SseEvent | undefined {
  const lines = rawEvent.split("\n");
  const dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let retryMs: number | undefined;
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") dataLines.push(value);
    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "retry") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) retryMs = parsed;
    }
  }
  if (dataLines.length === 0 && id === undefined && event === undefined && retryMs === undefined) {
    return undefined;
  }
  return {
    data: dataLines.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(retryMs !== undefined ? { retryMs } : {}),
  };
}

function parseSseJson(data: string, serverName: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new McpProtocolError(
      `MCP HTTP server '${serverName}' emitted invalid SSE JSON: ${getErrorMessage(error)}.`,
    );
  }
}

function normalizeSseBuffer(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function safeReadErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed === "") return "";
    return `: ${trimmed.slice(0, MAX_HTTP_ERROR_BODY_CHARS)}`;
  } catch (_error) {
    return "";
  }
}
