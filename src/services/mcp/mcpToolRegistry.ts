/** Bridges configured MCP server tools into nova-code Tool objects. */

import type { ResolvedConfig } from "../../config/config.ts";
import { ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import { McpStdioClient } from "./McpStdioClient.ts";
import { McpStreamableHttpClient } from "./McpStreamableHttpClient.ts";
import { McpProtocolError } from "./protocol.ts";
import type {
  McpCallToolResult,
  McpClient,
  McpDiscoveredServer,
  McpReadResourceResult,
  McpServerConfig,
  McpServersConfig,
  McpToolDefinition,
} from "./types.ts";
import { MCP_TOOLS_LIST_CHANGED_NOTIFICATION } from "./types.ts";

const MCP_TOOL_PREFIX = "MCP";
const MAX_FORMATTED_RESULT_CHARS = 50_000;

export interface McpToolRegistry {
  readonly tools: readonly Tool[];
  readonly warnings: readonly string[];
  readonly servers: readonly McpDiscoveredServer[];
  readonly readResource: (
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ) => Promise<McpReadResourceResult>;
  readonly waitForPendingRefreshes: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface ConnectedServer {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly client: McpClient;
  tools: readonly McpToolDefinition[];
  refreshPromise?: Promise<void>;
  refreshAgain: boolean;
  readyForRefresh: boolean;
}

/** Load all configured MCP servers and expose their tools to QueryEngine. */
export async function createMcpToolRegistry(config: ResolvedConfig): Promise<McpToolRegistry> {
  return await createMcpToolRegistryFromServers(config.mcpServers);
}

/** Test-friendly entry that bypasses LLM config resolution. */
export async function createMcpToolRegistryFromServers(
  serversConfig: McpServersConfig,
): Promise<McpToolRegistry> {
  const connected: ConnectedServer[] = [];
  const warnings: string[] = [];
  let exposedTools: readonly Tool[] = [];
  let closed = false;

  const rebuildTools = (): void => {
    const result = buildExposedTools(connected);
    exposedTools = result.tools;
    warnings.push(...result.warnings);
  };

  const refreshServer = async (server: ConnectedServer): Promise<void> => {
    const listed = await server.client.listTools();
    server.tools = listed.tools;
    rebuildTools();
  };

  const scheduleRefresh = (server: ConnectedServer): void => {
    if (closed) return;
    if (!server.readyForRefresh) {
      server.refreshAgain = true;
      return;
    }
    if (server.refreshPromise !== undefined) {
      server.refreshAgain = true;
      return;
    }
    const refresh = runRefreshLoop(server, refreshServer, warnings, () => closed);
    server.refreshPromise = refresh.finally(() => {
      if (server.refreshPromise === refresh) server.refreshPromise = undefined;
    });
  };

  for (const [name, serverConfig] of Object.entries(serversConfig)) {
    if (serverConfig.disabled === true) continue;
    let client: McpClient | undefined;
    try {
      client = createMcpClient(name, serverConfig);
      const server: ConnectedServer = {
        name,
        config: serverConfig,
        client,
        tools: [],
        refreshAgain: false,
        readyForRefresh: false,
      };
      client.onNotification((method) => {
        if (method === MCP_TOOLS_LIST_CHANGED_NOTIFICATION) scheduleRefresh(server);
      });
      await client.connect();
      const listed = await client.listTools();
      server.tools = listed.tools;
      server.readyForRefresh = true;
      connected.push(server);
      if (server.refreshAgain) scheduleRefresh(server);
    } catch (error) {
      await client?.close();
      warnings.push(formatMcpStartupWarning(name, error));
    }
  }

  rebuildTools();

  return {
    get tools() {
      return exposedTools;
    },
    get warnings() {
      return warnings;
    },
    get servers() {
      return connected.map((server) => ({
        name: server.name,
        transport: getTransportKind(server.config),
        toolCount: server.tools.length,
        serverInfo: server.client.serverInfo?.serverInfo,
        ...(server.client.serverInfo?.instructions !== undefined
          ? { instructions: server.client.serverInfo.instructions }
          : {}),
      }));
    },
    readResource: async (serverName, uri, signal) => {
      const server = findConnectedServer(connected, serverName);
      if (server === undefined) {
        throw new McpProtocolError(`MCP server '${serverName}' is not connected.`);
      }
      return await server.client.readResource(uri, signal);
    },
    waitForPendingRefreshes: async () => {
      await Promise.allSettled(
        connected
          .map((server) => server.refreshPromise)
          .filter((promise): promise is Promise<void> => promise !== undefined),
      );
    },
    close: async () => {
      closed = true;
      await Promise.allSettled(
        connected
          .map((server) => server.refreshPromise)
          .filter((promise): promise is Promise<void> => promise !== undefined),
      );
      await Promise.allSettled(connected.map((server) => server.client.close()));
    },
  };
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}

function findConnectedServer(
  connected: readonly ConnectedServer[],
  serverName: string,
): ConnectedServer | undefined {
  return connected.find(
    (server) => server.name === serverName || sanitizeToolNamePart(server.name) === serverName,
  );
}

async function runRefreshLoop(
  server: ConnectedServer,
  refreshServer: (server: ConnectedServer) => Promise<void>,
  warnings: string[],
  isClosed: () => boolean,
): Promise<void> {
  do {
    server.refreshAgain = false;
    try {
      await refreshServer(server);
    } catch (error) {
      warnings.push(formatMcpRefreshWarning(server.name, error));
      return;
    }
  } while (server.refreshAgain && !isClosed());
}

function createMcpClient(name: string, config: McpServerConfig): McpClient {
  if (config.type === "http") return new McpStreamableHttpClient(name, config);
  return new McpStdioClient(name, config);
}

function buildExposedTools(connected: readonly ConnectedServer[]): {
  readonly tools: readonly Tool[];
  readonly warnings: readonly string[];
} {
  const usedNames = new Set<string>();
  const tools: Tool[] = [];
  const warnings: string[] = [];
  for (const server of connected) {
    for (const mcpTool of server.tools) {
      const exposedName = buildMcpToolName(server.name, mcpTool.name);
      if (usedNames.has(exposedName)) {
        warnings.push(
          `MCP server '${server.name}' tool '${mcpTool.name}' skipped: duplicate exposed name '${exposedName}'.`,
        );
        continue;
      }
      usedNames.add(exposedName);
      tools.push(toNovaTool(server, mcpTool, exposedName));
    }
  }
  return { tools, warnings };
}

function toNovaTool(
  server: ConnectedServer,
  mcpTool: McpToolDefinition,
  exposedName: string,
): Tool {
  return {
    name: exposedName,
    description: formatMcpToolDescription(server.name, mcpTool),
    input_schema: mcpTool.inputSchema,
    requiresApproval: server.config.autoApprove !== true,
    execute: async (input, context) => {
      const result = await server.client.callTool(mcpTool.name, input, context.signal);
      const formatted = formatMcpCallToolResult(result);
      if (result.isError === true) {
        throw new ToolExecutionError(exposedName, formatted);
      }
      return formatted;
    },
  };
}

function formatMcpToolDescription(serverName: string, tool: McpToolDefinition): string {
  const lines = [`MCP server '${serverName}' tool '${tool.name}'.`];
  if (tool.title !== undefined) lines.push(`Title: ${tool.title}`);
  if (tool.description !== undefined) lines.push(tool.description);
  lines.push("Use only when the external MCP server is relevant to the user's task.");
  return lines.join("\n");
}

export function formatMcpCallToolResult(result: McpCallToolResult): string {
  const chunks: string[] = [];
  for (const block of result.content) {
    chunks.push(formatMcpContentBlock(block));
  }
  if (result.structuredContent !== undefined) {
    chunks.push(`Structured content:\n${safeStringify(result.structuredContent)}`);
  }
  const formatted = chunks.length === 0 ? "(empty MCP result)" : chunks.join("\n\n");
  if (formatted.length <= MAX_FORMATTED_RESULT_CHARS) return formatted;
  return `${formatted.slice(0, MAX_FORMATTED_RESULT_CHARS)}\n[truncated]`;
}

function formatMcpContentBlock(block: Readonly<Record<string, unknown>>): string {
  const type = typeof block["type"] === "string" ? block["type"] : "unknown";
  if (type === "text" && typeof block["text"] === "string") return block["text"];
  if ((type === "image" || type === "audio") && typeof block["mimeType"] === "string") {
    const data = typeof block["data"] === "string" ? block["data"] : "";
    return `[${type}: ${block["mimeType"]}, ${data.length} base64 chars]`;
  }
  if (type === "resource_link") {
    const uri = typeof block["uri"] === "string" ? block["uri"] : "unknown";
    const name = typeof block["name"] === "string" ? ` ${block["name"]}` : "";
    return `[resource_link:${name} ${uri}]`;
  }
  if (type === "resource" && block["resource"] !== undefined) {
    return `Resource:\n${safeStringify(block["resource"])}`;
  }
  return `${type}:\n${safeStringify(block)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return error instanceof Error ? `[unserializable: ${error.message}]` : "[unserializable]";
  }
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized === "" ? "unknown" : sanitized;
}

function formatMcpStartupWarning(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `MCP server '${name}' unavailable: ${message}`;
}

function formatMcpRefreshWarning(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `MCP server '${name}' tool list refresh failed: ${message}`;
}

function getTransportKind(config: McpServerConfig): "stdio" | "http" {
  return config.type === "http" ? "http" : "stdio";
}
