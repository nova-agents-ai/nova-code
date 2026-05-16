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

  test("refreshes bridged tools after tools/list_changed notification", async () => {
    registry = await createMcpToolRegistryFromServers({
      fixture: {
        command: "bun",
        args: ["run", FIXTURE_SERVER_PATH],
        env: { MCP_FIXTURE_LIST_CHANGED: "1" },
        autoApprove: true,
      },
    });

    expect(registry.tools.map((tool) => tool.name)).toEqual(["MCP__fixture__echo"]);

    await waitFor(
      () => registry?.tools.some((tool) => tool.name === "MCP__fixture__echo2") === true,
    );
    await registry.waitForPendingRefreshes();

    expect(registry.tools.map((tool) => tool.name)).toEqual([
      "MCP__fixture__echo",
      "MCP__fixture__echo2",
    ]);
  });

  test("startup errors become warnings and do not prevent builtin tools from loading", async () => {
    registry = await createMcpToolRegistryFromServers({
      missing: { command: "definitely-not-a-real-mcp-command" },
    });

    expect(registry.tools).toEqual([]);
    expect(registry.warnings[0]).toContain("MCP server 'missing' unavailable");
  });
});

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
