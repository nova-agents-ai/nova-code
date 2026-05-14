/** M6 e2e：ask + mock LLM 主动调用 TodoWrite，并把 ASCII 任务表展示给用户。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

async function runAskChild(params: { readonly home: string }): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask", "implement a multi-file feature"],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: params.home,
      USERPROFILE: params.home,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "todo-loop",
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

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m6e2e-"));
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("m6-e2e-todowrite", () => {
  test("模型在复杂任务开头调用 TodoWrite，ask stderr 展示任务表", async () => {
    const result = await runAskChild({ home });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Planning the multi-step task");
    expect(result.stdout).toContain("Done. TodoWrite tracked the multi-step task.");
    expect(result.stderr).toContain("[tool] TodoWrite");
    expect(result.stderr).toContain("Current todos:");
    expect(result.stderr).toContain("[x] 1. Inspect project structure");
    expect(result.stderr).toContain("[*] 2. Implementing changes across files");
    expect(result.stderr).toContain("[ ] 3. Run verification");
  }, 20_000);
});
