import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { McpToolRegistry } from "./mcpToolRegistry.ts";
import { buildMcpToolName, createMcpToolRegistryFromServers } from "./mcpToolRegistry.ts";

const FIXTURE_SERVER_PATH = fileURLToPath(
  new URL("./fixtures/stdioEchoServer.ts", import.meta.url),
);

let registry: McpToolRegistry | undefined;

afterEach(async () => {
  await registry?.close();
  registry = undefined;
});

describe("mcpToolRegistry", () => {
  test("buildMcpToolName exposes stable MCP__server__tool names", () => {
    expect(buildMcpToolName("my-server", "read_file")).toBe("MCP__my_server__read_file");
  });

  test("discovers MCP tools and bridges tools/call to Tool.execute", async () => {
    registry = await createMcpToolRegistryFromServers({
      fixture: {
        command: "bun",
        args: ["run", FIXTURE_SERVER_PATH],
        autoApprove: true,
      },
    });

    expect(registry.warnings).toEqual([]);
    expect(registry.tools.map((tool) => tool.name)).toEqual(["MCP__fixture__echo"]);
    const tool = registry.tools[0];
    expect(tool?.requiresApproval).toBe(false);
    const result = await tool?.execute(
      { message: "through registry" },
      { signal: new AbortController().signal },
    );
    expect(result).toContain("echo:through registry");
    expect(result).toContain("Structured content");
  });

  test("startup errors become warnings and do not prevent builtin tools from loading", async () => {
    registry = await createMcpToolRegistryFromServers({
      missing: { command: "definitely-not-a-real-mcp-command" },
    });

    expect(registry.tools).toEqual([]);
    expect(registry.warnings[0]).toContain("MCP server 'missing' unavailable");
  });
});
