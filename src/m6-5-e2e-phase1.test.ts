/** M6.5 e2e：补齐 Phase 1 M3 权限主路径的真实子进程覆盖。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runEditLoopAsk(params: {
  readonly home: string;
  readonly workDir: string;
  readonly skipPermissions?: boolean;
}): Promise<RunAskResult> {
  const args = ["ask"];
  if (params.skipPermissions === true) args.push("--dangerously-skip-permissions");
  args.push("rename oldFn to newFn");

  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, ...args],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: params.home,
      USERPROFILE: params.home,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "edit-loop",
      MOCK_EDIT_WORKDIR: params.workDir,
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
let workDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m65-home-"));
  workDir = await mkdtemp(join(tmpdir(), "nova-m65-work-"));
  await Bun.write(join(workDir, "a.ts"), "export function oldFn() { return 1; }\n");
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("m6-5-e2e-phase1 permissions", () => {
  test("ask 默认 acceptEdits：FileEdit 放行，Bash headless deny", async () => {
    const result = await runEditLoopAsk({ home, workDir });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("[permission] asking: Bash");
    expect(result.stderr).toContain("[permission] denied: Bash");
    expect(result.stdout).toContain("Done. Renamed oldFn to newFn");

    const finalContent = await readFile(join(workDir, "a.ts"), "utf8");
    expect(finalContent).toBe("export function newFn() { return 1; }\n");
  }, 20_000);

  test("--dangerously-skip-permissions：普通 Bash 直接执行但 DENY_PATTERNS 仍由单测覆盖", async () => {
    const result = await runEditLoopAsk({ home, workDir, skipPermissions: true });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("[tool] Bash");
    expect(result.stderr).not.toContain("[permission] denied: Bash");
  }, 20_000);
});
