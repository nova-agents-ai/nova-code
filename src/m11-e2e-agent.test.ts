/** M11 e2e：ask + mock LLM 触发 AgentTool 派生同步子 agent。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m11-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("m11-e2e-agent", () => {
  test("AgentTool runs a sub-agent and returns its summary to the parent loop", async () => {
    const result = await runAskChild(home);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("[tool] Agent");
    expect(result.stdout).toContain("Done. Agent completed.");
  }, 20_000);
});

async function runAskChild(homeDir: string): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask", "delegate this lookup to an agent"],
    cwd: homeDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: homeDir,
      USERPROFILE: homeDir,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "agent-loop",
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
