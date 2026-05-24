/** Minimal MCP stdio JSON-RPC client for tools/list and tools/call. */

import { buildMcpProcessEnv } from "./environment.ts";
import {
  getErrorMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isRecord,
  type JsonRpcResponse,
  McpProtocolError,
  parseCallToolResult,
  parseInitializeResult,
  parseListToolsResult,
  parseReadResourceResult,
} from "./protocol.ts";
import type { McpClient, McpNotificationListener, McpStdioServerConfig } from "./types.ts";
import {
  MCP_PROTOCOL_VERSION,
  type McpCallToolResult,
  type McpInitializeResult,
  type McpListToolsResult,
  type McpReadResourceResult,
  type McpToolDefinition,
} from "./types.ts";

export { McpProtocolError } from "./protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_STDERR_CHARS = 8_000;
const CLIENT_NAME = "nova-code";
const CLIENT_VERSION = "0.8.0";

type RequestId = number;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly abortListener?: () => void;
  readonly signal?: AbortSignal;
}

interface McpRequestOptions {
  readonly signal?: AbortSignal;
}

export class McpStdioClient implements McpClient {
  private readonly serverName: string;
  private readonly config: McpStdioServerConfig;
  private readonly timeoutMs: number;
  private readonly notificationListeners = new Set<McpNotificationListener>();
  private nextId = 1;
  private process: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  private stdoutTask: Promise<void> | undefined;
  private stderrTask: Promise<void> | undefined;
  private stderrBuffer = "";
  private pending = new Map<RequestId, PendingRequest>();
  private closed = false;
  private initializeResult: McpInitializeResult | undefined;

  constructor(serverName: string, config: McpStdioServerConfig) {
    this.serverName = serverName;
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get serverInfo(): McpInitializeResult | undefined {
    return this.initializeResult;
  }

  get stderrSnippet(): string {
    return this.stderrBuffer;
  }

  get diagnosticSnippet(): string {
    return this.stderrBuffer;
  }

  onNotification(listener: McpNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async connect(signal?: AbortSignal): Promise<McpInitializeResult> {
    if (this.process !== undefined) return this.initializeResult ?? (await this.initialize(signal));
    const command = [this.config.command, ...(this.config.args ?? [])];
    this.process = Bun.spawn({
      cmd: command,
      cwd: this.config.cwd,
      env: buildMcpProcessEnv(this.config.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdoutTask = this.readStdout().catch((error: unknown) => this.failAllPending(error));
    this.stderrTask = this.readStderr().catch(() => undefined);
    this.process.exited
      .then((code) => this.handleExit(code))
      .catch((error: unknown) => {
        this.failAllPending(error);
      });
    return await this.initialize(signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpListToolsResult> {
    let cursor: string | undefined;
    const tools: McpToolDefinition[] = [];
    do {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, {
        signal,
      });
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
      { signal },
    );
    return parseCallToolResult(result, this.serverName, name);
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    const result = await this.request("resources/read", { uri }, { signal });
    return parseReadResourceResult(result, this.serverName, uri);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new McpProtocolError(`MCP server '${this.serverName}' closed.`));
    const proc = this.process;
    if (proc === undefined) return;
    try {
      proc.stdin.end();
    } catch (_error) {
      // stdin may already be closed by a crashed server.
    }
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await Promise.race([proc.exited.catch(() => 1), sleep(1_000)]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await Promise.allSettled([this.stdoutTask, this.stderrTask]);
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
      { signal },
    );
    const initialized = parseInitializeResult(result, this.serverName);
    this.initializeResult = initialized;
    this.notify("notifications/initialized", {});
    return initialized;
  }

  private async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: McpRequestOptions,
  ): Promise<unknown> {
    if (this.closed) throw new McpProtocolError(`MCP server '${this.serverName}' is closed.`);
    const proc = this.process;
    if (proc === undefined) {
      throw new McpProtocolError(`MCP server '${this.serverName}' not started.`);
    }
    if (options.signal?.aborted === true) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const id = this.nextId;
    this.nextId += 1;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpProtocolError(`MCP request '${method}' to '${this.serverName}' timed out.`));
      }, this.timeoutMs);
      const abortListener =
        options.signal === undefined
          ? undefined
          : () => {
              this.pending.delete(id);
              clearTimeout(timeout);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            };
      if (abortListener !== undefined && options.signal !== undefined) {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timeout,
        ...(abortListener !== undefined ? { abortListener } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private notify(method: string, params: Readonly<Record<string, unknown>>): void {
    const proc = this.process;
    if (proc === undefined || this.closed) return;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private async readStdout(): Promise<void> {
    const proc = this.process;
    if (proc === undefined) return;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.consumeLines(buffer);
      }
      buffer += decoder.decode();
      this.consumeLines(`${buffer}\n`);
    } finally {
      reader.releaseLock();
    }
  }

  private consumeLines(buffer: string): string {
    let start = 0;
    while (true) {
      const newline = buffer.indexOf("\n", start);
      if (newline === -1) return buffer.slice(start);
      const line = buffer.slice(start, newline).trim();
      if (line !== "") this.handleMessageLine(line);
      start = newline + 1;
    }
  }

  private handleMessageLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.failAllPending(
        new McpProtocolError(
          `MCP server '${this.serverName}' emitted invalid JSON: ${getErrorMessage(error)}.`,
        ),
      );
      return;
    }
    if (!isRecord(parsed)) return;
    if (isJsonRpcResponse(parsed) && typeof parsed.id === "number") {
      this.handleResponse(parsed as JsonRpcResponse);
      return;
    }
    if (isJsonRpcRequest(parsed)) {
      this.handleServerRequest(parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      this.emitNotification(parsed.method, parsed.params);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (pending.abortListener !== undefined && pending.signal !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    if (response.error !== undefined) {
      pending.reject(
        new McpProtocolError(
          `MCP request '${pending.method}' to '${this.serverName}' failed: ${response.error.message}`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleServerRequest(request: Readonly<Record<string, unknown>>): void {
    const proc = this.process;
    if (proc === undefined) return;
    const id = request["id"];
    if (typeof id !== "number" && typeof id !== "string") return;
    const method = request["method"];
    if (method === "ping") {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
      return;
    }
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${String(method)}`,
        },
      })}\n`,
    );
  }

  private emitNotification(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  private async readStderr(): Promise<void> {
    const proc = this.process;
    if (proc === undefined) return;
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.appendStderr(decoder.decode(value, { stream: true }));
      }
      this.appendStderr(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }

  private appendStderr(chunk: string): void {
    if (chunk === "") return;
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_STDERR_CHARS);
  }

  private handleExit(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(
      new McpProtocolError(
        `MCP server '${this.serverName}' exited with code ${code}.${formatStderr(this.stderrBuffer)}`,
      ),
    );
  }

  private failAllPending(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) {
      clearTimeout(pending.timeout);
      if (pending.abortListener !== undefined && pending.signal !== undefined) {
        pending.signal.removeEventListener("abort", pending.abortListener);
      }
      pending.reject(error);
    }
  }
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === "") return "";
  return ` stderr: ${trimmed}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
