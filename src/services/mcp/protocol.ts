/** Shared MCP JSON-RPC parsing and validation helpers. */

import type { ToolInputSchema } from "../../Tool.ts";
import type {
  McpCallToolResult,
  McpInitializeResult,
  McpListToolsResult,
  McpReadResourceResult,
  McpResourceContent,
  McpToolAnnotations,
  McpToolDefinition,
} from "./types.ts";

export type JsonRpcId = number | string;

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorPayload;
}

export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcRequestMessage {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
}

export interface JsonRpcNotificationMessage {
  readonly jsonrpc?: string;
  readonly method: string;
  readonly params?: unknown;
}

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export function parseInitializeResult(value: unknown, serverName: string): McpInitializeResult {
  if (!isRecord(value)) {
    throw new McpProtocolError(`MCP server '${serverName}' returned invalid initialize result.`);
  }
  const protocolVersion = value["protocolVersion"];
  const capabilities = value["capabilities"];
  const serverInfo = value["serverInfo"];
  if (typeof protocolVersion !== "string" || !isRecord(capabilities) || !isRecord(serverInfo)) {
    throw new McpProtocolError(`MCP server '${serverName}' returned incomplete initialize result.`);
  }
  const name = serverInfo["name"];
  const version = serverInfo["version"];
  if (typeof name !== "string" || typeof version !== "string") {
    throw new McpProtocolError(`MCP server '${serverName}' returned invalid serverInfo.`);
  }
  return {
    protocolVersion,
    capabilities,
    serverInfo: {
      name,
      version,
      ...(typeof serverInfo["title"] === "string" ? { title: serverInfo["title"] } : {}),
    },
    ...(typeof value["instructions"] === "string" ? { instructions: value["instructions"] } : {}),
  };
}

export function parseListToolsResult(value: unknown, serverName: string): McpListToolsResult {
  if (!isRecord(value) || !Array.isArray(value["tools"])) {
    throw new McpProtocolError(`MCP server '${serverName}' returned invalid tools/list result.`);
  }
  return {
    tools: value["tools"].map((item, index) => parseToolDefinition(item, serverName, index)),
    ...(typeof value["nextCursor"] === "string" ? { nextCursor: value["nextCursor"] } : {}),
  };
}

export function parseCallToolResult(
  value: unknown,
  serverName: string,
  toolName: string,
): McpCallToolResult {
  if (!isRecord(value) || !Array.isArray(value["content"])) {
    throw new McpProtocolError(
      `MCP server '${serverName}' returned invalid tools/call result for '${toolName}'.`,
    );
  }
  return {
    content: value["content"].map(parseContentBlock),
    ...(isRecord(value["structuredContent"])
      ? { structuredContent: value["structuredContent"] }
      : {}),
    ...(typeof value["isError"] === "boolean" ? { isError: value["isError"] } : {}),
  };
}

export function parseReadResourceResult(
  value: unknown,
  serverName: string,
  uri: string,
): McpReadResourceResult {
  if (!isRecord(value) || !Array.isArray(value["contents"])) {
    throw new McpProtocolError(
      `MCP server '${serverName}' returned invalid resources/read result for '${uri}'.`,
    );
  }
  return {
    contents: value["contents"].map((item, index) =>
      parseResourceContent(item, serverName, uri, index),
    ),
  };
}

export function isJsonRpcResponse(
  value: Readonly<Record<string, unknown>>,
): value is JsonRpcResponse & Readonly<Record<string, unknown>> {
  return isJsonRpcId(value["id"]) && ("result" in value || "error" in value);
}

export function isJsonRpcRequest(
  value: Readonly<Record<string, unknown>>,
): value is JsonRpcRequestMessage & Readonly<Record<string, unknown>> {
  return typeof value["method"] === "string" && isJsonRpcId(value["id"]);
}

export function isJsonRpcNotification(
  value: Readonly<Record<string, unknown>>,
): value is JsonRpcNotificationMessage & Readonly<Record<string, unknown>> {
  return typeof value["method"] === "string" && !("id" in value);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseToolDefinition(value: unknown, serverName: string, index: number): McpToolDefinition {
  if (!isRecord(value)) {
    throw new McpProtocolError(
      `MCP server '${serverName}' returned non-object tool at index ${index}.`,
    );
  }
  const name = value["name"];
  const inputSchema = value["inputSchema"];
  if (typeof name !== "string" || !isToolInputSchema(inputSchema)) {
    throw new McpProtocolError(
      `MCP server '${serverName}' returned invalid tool at index ${index}.`,
    );
  }
  return {
    name,
    inputSchema,
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
    ...("outputSchema" in value ? { outputSchema: value["outputSchema"] } : {}),
    ...(isRecord(value["annotations"])
      ? { annotations: parseToolAnnotations(value["annotations"]) }
      : {}),
  };
}

function parseToolAnnotations(value: Readonly<Record<string, unknown>>): McpToolAnnotations {
  return {
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["readOnlyHint"] === "boolean" ? { readOnlyHint: value["readOnlyHint"] } : {}),
    ...(typeof value["destructiveHint"] === "boolean"
      ? { destructiveHint: value["destructiveHint"] }
      : {}),
    ...(typeof value["idempotentHint"] === "boolean"
      ? { idempotentHint: value["idempotentHint"] }
      : {}),
    ...(typeof value["openWorldHint"] === "boolean"
      ? { openWorldHint: value["openWorldHint"] }
      : {}),
  };
}

function parseContentBlock(
  value: unknown,
): Readonly<Record<string, unknown>> & { readonly type: string } {
  if (!isRecord(value)) return { type: "unknown" };
  const type = typeof value["type"] === "string" ? value["type"] : "unknown";
  return {
    ...value,
    type,
  };
}

function parseResourceContent(
  value: unknown,
  serverName: string,
  uri: string,
  index: number,
): McpResourceContent {
  if (!isRecord(value)) {
    throw new McpProtocolError(
      `MCP server '${serverName}' returned non-object resource content at '${uri}' index ${index}.`,
    );
  }
  const contentUri = value["uri"];
  if (typeof contentUri !== "string") {
    throw new McpProtocolError(
      `MCP server '${serverName}' returned resource content without uri at '${uri}' index ${index}.`,
    );
  }
  return {
    ...value,
    uri: contentUri,
    ...(typeof value["mimeType"] === "string" ? { mimeType: value["mimeType"] } : {}),
    ...(typeof value["text"] === "string" ? { text: value["text"] } : {}),
    ...(typeof value["blob"] === "string" ? { blob: value["blob"] } : {}),
  };
}

function isToolInputSchema(value: unknown): value is ToolInputSchema {
  if (!isRecord(value)) return false;
  if (value["type"] !== "object") return false;
  const properties = value["properties"];
  if (properties !== undefined && !isRecord(properties)) return false;
  const required = value["required"];
  if (required !== undefined) {
    return Array.isArray(required) && required.every((item) => typeof item === "string");
  }
  return true;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}
