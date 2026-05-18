/** M12 e2e：ask + mock LLM 验证 .claude/rules paths 延迟注入。 */

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
  readonly messageCount: number;
  readonly systemSnippet?: string;
}

let workDir: string;
let mockLogFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-m12-rules-"));
  mockLogFile = join(workDir, "mock-requests.jsonl");
  await writeRulesFixture(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("m12-e2e-rules", () => {
  test("paths rule is absent before FileRead and present on the next LLM turn", async () => {
    const result = await runAskChild(workDir, mockLogFile);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("[tool] FileRead");

    const log = await readMockLogEntries(mockLogFile);
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]?.systemSnippet ?? "").not.toContain("M12_TS_RULE_MARKER");
    expect(log[1]?.systemSnippet ?? "").toContain("M12_TS_RULE_MARKER");
  }, 20_000);
});

async function writeRulesFixture(dir: string): Promise<void> {
  await Bun.write(join(dir, ".git"), "gitdir: fake");
  await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await mkdir(join(dir, ".claude", "rules"), { recursive: true });
  await Bun.write(
    join(dir, ".claude", "rules", "typescript.md"),
    `---
paths: ["src/**/*.ts"]
---
M12_TS_RULE_MARKER
Only applies to TypeScript source files.
`,
  );
}

async function runAskChild(cwd: string, logFile: string): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", BIN_PATH, "ask", "read src/a.ts and summarize"],
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      USERPROFILE: cwd,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "rules-loop",
      NOVA_MOCK_LOG_FILE: logFile,
      MOCK_RULES_FILE_PATH: "src/a.ts",
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
