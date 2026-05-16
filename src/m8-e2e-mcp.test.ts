/** M8 e2e：ask + mock LLM 调用配置中的 MCP stdio server tool。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));
const FIXTURE_SERVER_PATH = fileURLToPath(
  new URL("./services/mcp/fixtures/stdioEchoServer.ts", import.meta.url),
);

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m8-home-"));
  await writeMcpConfig(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("m8-e2e-mcp", () => {
  test("模型可调用从 MCP stdio server 发现的工具", async () => {
    const result = await runAskChild(home);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Calling MCP tool");
    expect(result.stdout).toContain("Done. MCP tool completed.");
    expect(result.stderr).toContain("[tool] MCP__fixture__echo");
    expect(result.stderr).not.toContain("[permission] denied");
  }, 20_000);
});

async function writeMcpConfig(homeDir: string): Promise<void> {
  const dir = join(homeDir, ".nova-code");
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          fixture: {
            command: "bun",
            args: ["run", FIXTURE_SERVER_PATH],
            autoApprove: true,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runAskChild(homeDir: string): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask", "use the configured MCP echo tool"],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: homeDir,
      USERPROFILE: homeDir,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "mcp-loop",
      MOCK_MCP_TOOL_NAME: "MCP__fixture__echo",
      NOVA_WEB_PROXY: "",
      NOVA_WEB_PROXY_DOMAINS: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutHandle = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}
