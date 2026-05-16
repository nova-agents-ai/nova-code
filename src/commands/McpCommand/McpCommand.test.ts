import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPersistedConfig } from "../../config/config.ts";
import { runMcpCommand } from "./McpCommand.ts";

const FIXTURE_SERVER_PATH = fileURLToPath(
  new URL("../../services/mcp/fixtures/stdioEchoServer.ts", import.meta.url),
);

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-mcp-command-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function makeIO(): { readonly stdout: string[]; readonly stderr: string[] } {
  return { stdout: [], stderr: [] };
}

describe("mcp command", () => {
  test("add/list/remove manages mcpServers in config", async () => {
    const io = makeIO();
    const options = {
      configSource: { homeDir: home },
      io: {
        stdout: (text: string) => io.stdout.push(text),
        stderr: (text: string) => io.stderr.push(text),
      },
    };

    const added = await runMcpCommand(
      [
        "add",
        "fixture",
        "--auto-approve",
        "--timeout-ms",
        "5000",
        "--env",
        "TOKEN=secret",
        "--",
        "bun",
        "run",
        FIXTURE_SERVER_PATH,
      ],
      options,
    );
    expect(added).toBe(0);

    const saved = await loadPersistedConfig({ homeDir: home });
    const fixtureConfig = saved.mcpServers?.["fixture"];
    expect(fixtureConfig?.type).toBe("stdio");
    if (fixtureConfig?.type === "http") throw new Error("expected stdio config");
    expect(fixtureConfig?.command).toBe("bun");
    expect(fixtureConfig?.args).toEqual(["run", FIXTURE_SERVER_PATH]);
    expect(fixtureConfig?.autoApprove).toBe(true);
    expect(fixtureConfig?.env?.["TOKEN"]).toBe("secret");

    const listed = await runMcpCommand(["list"], options);
    expect(listed).toBe(0);
    expect(io.stdout.join("")).toContain("fixture\tenabled, autoApprove\tbun");

    const removed = await runMcpCommand(["remove", "fixture"], options);
    expect(removed).toBe(0);
    const afterRemove = await loadPersistedConfig({ homeDir: home });
    expect(afterRemove.mcpServers?.["fixture"]).toBeUndefined();
  });

  test("add-http/list manages Streamable HTTP MCP config", async () => {
    const io = makeIO();
    const options = {
      configSource: { homeDir: home },
      io: {
        stdout: (text: string) => io.stdout.push(text),
        stderr: (text: string) => io.stderr.push(text),
      },
    };

    const added = await runMcpCommand(
      [
        "add-http",
        "remote",
        "--auto-approve",
        "--timeout-ms",
        "7000",
        "--header",
        `Authorization=Bearer \${MCP_TOKEN}`,
        "https://mcp.example/mcp",
      ],
      options,
    );

    expect(added).toBe(0);
    const saved = await loadPersistedConfig({ homeDir: home });
    expect(saved.mcpServers?.["remote"]).toEqual({
      type: "http",
      url: "https://mcp.example/mcp",
      headers: { Authorization: `Bearer \${MCP_TOKEN}` },
      timeoutMs: 7000,
      autoApprove: true,
    });

    const listed = await runMcpCommand(["list"], options);
    expect(listed).toBe(0);
    expect(io.stdout.join("")).toContain(
      "remote\tenabled, autoApprove\thttp https://mcp.example/mcp",
    );
  });

  test("tools connects configured servers and prints exposed tool names", async () => {
    const io = makeIO();
    const options = {
      configSource: { homeDir: home },
      io: {
        stdout: (text: string) => io.stdout.push(text),
        stderr: (text: string) => io.stderr.push(text),
      },
    };
    await runMcpCommand(["add", "fixture", "--", "bun", "run", FIXTURE_SERVER_PATH], options);

    const exitCode = await runMcpCommand(["tools"], options);

    expect(exitCode).toBe(0);
    expect(io.stdout.join("")).toContain("MCP__fixture__echo");
  });

  test("invalid server names are rejected", async () => {
    const io = makeIO();
    const exitCode = await runMcpCommand(["add", "bad.name", "--", "bun"], {
      configSource: { homeDir: home },
      io: {
        stdout: (text: string) => io.stdout.push(text),
        stderr: (text: string) => io.stderr.push(text),
      },
    });

    expect(exitCode).toBe(1);
    expect(io.stderr.join("")).toContain("must match");
  });
});
