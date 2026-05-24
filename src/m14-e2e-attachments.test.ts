/** M14 e2e：ask + mock LLM 验证 @file 附件注入与 path-scoped rules 首轮生效。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface MockLogEntry {
  readonly lastUserText?: string;
  readonly systemSnippet?: string;
}

let workDir: string;
let mockLogFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-m14-attachments-"));
  mockLogFile = join(workDir, "mock-requests.jsonl");
  await writeFixture(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("m14-e2e-attachments", () => {
  test("@file injects file content and activates matching rules before first LLM request", async () => {
    const result = await runAskChild(workDir, mockLogFile);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const log = await readMockLogEntries(mockLogFile);
    expect(log).toHaveLength(1);
    expect(log[0]?.lastUserText ?? "").toContain("M14_FILE_MARKER");
    expect(log[0]?.lastUserText ?? "").toContain("<attachments_summary>");
    expect(log[0]?.systemSnippet ?? "").toContain("M14_RULE_MARKER");
  }, 20_000);
});

async function writeFixture(dir: string): Promise<void> {
  await Bun.write(join(dir, ".git"), "gitdir: fake");
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(join(dir, "src", "a.ts"), "export const marker = 'M14_FILE_MARKER';\n");
  await mkdir(join(dir, ".claude", "rules"), { recursive: true });
  await Bun.write(
    join(dir, ".claude", "rules", "typescript.md"),
    '---\npaths: ["src/**/*.ts"]\n---\nM14_RULE_MARKER\n',
  );
}

async function runAskChild(cwd: string, logFile: string): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", BIN_PATH, "ask", "请重构 @src/a.ts 并遵守相关规则"],
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      USERPROFILE: cwd,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "chat",
      NOVA_MOCK_LOG_FILE: logFile,
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

async function readMockLogEntries(path: string): Promise<readonly MockLogEntry[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as MockLogEntry);
}

function errnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
