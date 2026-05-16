/** Bridges configured MCP server tools into nova-code Tool objects. */

import type { ResolvedConfig } from "../../config/config.ts";
import { ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import { McpStdioClient } from "./McpStdioClient.ts";
import type {
  McpCallToolResult,
  McpDiscoveredServer,
  McpServersConfig,
  McpStdioServerConfig,
  McpToolDefinition,
} from "./types.ts";

const MCP_TOOL_PREFIX = "MCP";
const MAX_FORMATTED_RESULT_CHARS = 50_000;

export interface McpToolRegistry {
  readonly tools: readonly Tool[];
  readonly warnings: readonly string[];
  readonly servers: readonly McpDiscoveredServer[];
  readonly close: () => Promise<void>;
}

interface ConnectedServer {
  readonly name: string;
  readonly config: McpStdioServerConfig;
  readonly client: McpStdioClient;
  readonly tools: readonly McpToolDefinition[];
}

/** Load all configured MCP stdio servers and expose their tools to QueryEngine. */
export async function createMcpToolRegistry(config: ResolvedConfig): Promise<McpToolRegistry> {
  return await createMcpToolRegistryFromServers(config.mcpServers);
}

/** Test-friendly entry that bypasses LLM config resolution. */
export async function createMcpToolRegistryFromServers(
  serversConfig: McpServersConfig,
): Promise<McpToolRegistry> {
  const connected: ConnectedServer[] = [];
  const warnings: string[] = [];

  for (const [name, serverConfig] of Object.entries(serversConfig)) {
    if (serverConfig.disabled === true) continue;
    try {
      const client = new McpStdioClient(name, serverConfig);
      await client.connect();
      const listed = await client.listTools();
      connected.push({ name, config: serverConfig, client, tools: listed.tools });
    } catch (error) {
      warnings.push(formatMcpStartupWarning(name, error));
    }
  }

  const usedNames = new Set<string>();
  const tools: Tool[] = [];
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

  return {
    tools,
    warnings,
    servers: connected.map((server) => ({
      name: server.name,
      toolCount: server.tools.length,
      serverInfo: server.client.serverInfo?.serverInfo,
      ...(server.client.serverInfo?.instructions !== undefined
        ? { instructions: server.client.serverInfo.instructions }
        : {}),
    })),
    close: async () => {
      await Promise.allSettled(connected.map((server) => server.client.close()));
    },
  };
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
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
