/** M9 e2e：ask/chat 的 system prompt 会按用户 query 注入匹配到的 Skill。 */

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
  readonly lastUserText?: string;
  readonly hasTools: boolean;
  readonly toolChoiceType?: string;
  readonly systemSnippet?: string;
}

let home: string;
let mockLogFile: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m9-home-"));
  mockLogFile = join(home, "mock-requests.jsonl");
  await writeJavaSkill(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("m9-e2e-skills", () => {
  test("ask 根据 query 激活 ~/.agents/skills 下的 SKILL.md 并注入 system prompt", async () => {
    const result = await runAskChild(home, mockLogFile);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const log = await readMockLogEntries(mockLogFile);
    expect(log.length).toBeGreaterThanOrEqual(1);
    const first = log[0];
    expect(first?.systemSnippet ?? "").toContain("## Skill: java");
    expect(first?.systemSnippet ?? "").toContain("M9_JAVA_SKILL_BODY_MARKER");
  }, 20_000);
});

async function writeJavaSkill(homeDir: string): Promise<void> {
  const dir = join(homeDir, ".agents", "skills", "java");
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "SKILL.md"),
    `---
name: java
description: Java JVM backend and concurrency review skill.
---
# Java Skill
M9_JAVA_SKILL_BODY_MARKER
Prefer explicit concurrency, transaction, and error-handling checks.
`,
  );
}

async function runAskChild(homeDir: string, logFile: string): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask", "review this Java concurrency service"],
    cwd: homeDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: homeDir,
      USERPROFILE: homeDir,
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
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as MockLogEntry);
}
