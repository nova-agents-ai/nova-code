import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { McpStdioClient } from "./McpStdioClient.ts";

const FIXTURE_SERVER_PATH = fileURLToPath(
  new URL("./fixtures/stdioEchoServer.ts", import.meta.url),
);

let clients: McpStdioClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
});

function createFixtureClient(): McpStdioClient {
  const client = new McpStdioClient("fixture", {
    command: "bun",
    args: ["run", FIXTURE_SERVER_PATH],
  });
  clients.push(client);
  return client;
}

describe("McpStdioClient", () => {
  test("initialize + tools/list + tools/call over stdio JSON-RPC", async () => {
    const client = createFixtureClient();

    const initialized = await client.connect();
    expect(initialized.protocolVersion).toBe("2025-11-25");
    expect(initialized.serverInfo.name).toBe("fixture-echo");

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.name).toBe("echo");
    expect(listed.tools[0]?.inputSchema.required).toEqual(["message"]);

    const called = await client.callTool("echo", { message: "hello" });
    expect(called.content[0]?.text).toBe("echo:hello");
    expect(called.structuredContent?.["echoed"]).toBe("hello");

    const resource = await client.readResource("fixture://doc");
    expect(resource.contents[0]?.text).toBe("resource:fixture://doc");
  });
});
