/** M5 e2e：chat 退出时打印 cost 摘要，并把 ledger 落到 ~/.nova-code/cost.jsonl。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

async function runChatChild(params: {
  readonly home: string;
  readonly mockLogFile: string;
  readonly stdinLines: readonly string[];
}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "chat"],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: params.home,
      USERPROFILE: params.home,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "chat",
      NOVA_MOCK_LOG_FILE: params.mockLogFile,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(new TextEncoder().encode(`${params.stdinLines.join("\n")}\n`));
  const timeoutHandle = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

let home: string;
let mockLogFile: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m5e2e-"));
  mockLogFile = join(home, "mock-requests.jsonl");
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("m5-e2e-cost", () => {
  test("一轮 chat + /exit → stderr 打 cost，ledger 写入 cost.jsonl", async () => {
    const result = await runChatChild({
      home,
      mockLogFile,
      stdinLines: ["hello", "/exit"],
    });
    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("[cost] Total cost:");
    expect(result.stderr).toContain("[cost] Usage:");

    const ledger = await readFile(join(home, ".nova-code", "cost.jsonl"), "utf8");
    const lines = ledger.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"command":"chat"');
  }, 20_000);
});
