/** MCP protocol/domain types used by nova-code's minimal clients. */

import type { ToolInputSchema } from "../../Tool.ts";

/** Latest MCP protocol revision used by M8 handshake. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** tools/list_changed server notification method. */
export const MCP_TOOLS_LIST_CHANGED_NOTIFICATION = "notifications/tools/list_changed";

/** Safe JSON value shape for JSON-RPC payloads. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface McpBaseServerConfig {
  readonly disabled?: boolean;
  readonly timeoutMs?: number;
  /** User-managed trust switch. When true, bridged tools bypass normal approval prompts. */
  readonly autoApprove?: boolean;
}

export interface McpStdioServerConfig extends McpBaseServerConfig {
  readonly type?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface McpStreamableHttpServerConfig extends McpBaseServerConfig {
  readonly type: "http";
  /** Single MCP endpoint supporting Streamable HTTP POST and optional GET SSE. */
  readonly url: string;
  /** Static request headers, typically Authorization. Values may reference $ENV or ${ENV}. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioServerConfig | McpStreamableHttpServerConfig;

export type McpServersConfig = Readonly<Record<string, McpServerConfig>>;

export interface McpImplementation {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo: McpImplementation;
  readonly instructions?: string;
}

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: unknown;
  readonly annotations?: McpToolAnnotations;
}

export interface McpListToolsResult {
  readonly tools: readonly McpToolDefinition[];
  readonly nextCursor?: string;
}

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly resource?: unknown;
  readonly [key: string]: unknown;
}

export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export interface McpDiscoveredServer {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly toolCount: number;
  readonly serverInfo?: McpImplementation;
  readonly instructions?: string;
}

export type McpNotificationListener = (method: string, params: unknown) => void;

export interface McpClient {
  readonly serverInfo: McpInitializeResult | undefined;
  readonly diagnosticSnippet: string;
  connect(signal?: AbortSignal): Promise<McpInitializeResult>;
  listTools(signal?: AbortSignal): Promise<McpListToolsResult>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult>;
  onNotification(listener: McpNotificationListener): () => void;
  close(): Promise<void>;
}
