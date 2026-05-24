/** M15 e2e：chat + /plan + ExitPlanMode 审批后才能执行写工具。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunChatResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputFileText: string;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-m15-plan-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("m15-e2e-plan-mode", () => {
  test("/plan 后模型通过 ExitPlanMode 请求批准，获批后执行 FileWrite", async () => {
    const result = await runChatChild(workDir);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("[tool] ExitPlanMode");
    expect(result.stderr).toContain("[plan] Proposed implementation plan");
    expect(result.stderr).toContain("[tool] FileWrite");
    expect(result.stdout).toContain("Done. Plan approved and implemented.");
    expect(result.outputFileText).toBe("M15_PLAN_APPROVED\n");
  }, 20_000);
});

async function runChatChild(cwd: string): Promise<RunChatResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "chat", "--dangerously-skip-permissions"],
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      USERPROFILE: cwd,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "plan-loop",
      NOVA_WEB_PROXY: "",
      NOVA_WEB_PROXY_DOMAINS: "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write("/plan implement the approved marker file\n");
  proc.stdin.write("y\n");
  proc.stdin.write("/exit\n");
  proc.stdin.end();

  const timeoutHandle = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const outputFileText = await Bun.file(join(cwd, "plan-output.txt")).text();
  return { exitCode, stdout, stderr, outputFileText };
}
