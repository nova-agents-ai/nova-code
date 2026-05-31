/**
 * M16 e2e：auto memory 端到端 —— 子进程跑 ask + mock client，验证
 *
 *   1) 默认开启：system prompt 中含 `# auto memory` + `## MEMORY.md` 段，且
 *      MEMORY.md 文件不存在时显示"empty"降级文案
 *   2) 预置 MEMORY.md 文件 → 内容真的被加载到 system prompt 中
 *   3) 关闭（CLAUDE_CODE_DISABLE_AUTO_MEMORY=1）→ system prompt 完全不含
 *      memory 段，不发起 relevance / extractor 调用
 *
 * 不在此覆盖（已由单测 / QueryEngine 集成测试守住）：
 *   - per-turn LLM relevance selector（需要 mock 增加 memory-loop 场景，
 *     未来 M16.1 / e2e 套件增强时补）
 *   - 后台 extractor 真实跑通（同上）
 *   - FileWrite/FileEdit 到 memoryDir 内的 permission carve-out（已有 unit / QueryEngine 集成测试）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly mockLog: ReadonlyArray<MockLogEntry>;
}

interface MockLogEntry {
  readonly systemSnippet?: string;
  readonly lastUserText?: string;
  readonly turnIndex?: number;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-m16-mem-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("m16-e2e-memory", () => {
  test("memory 默认开启：system prompt 含 auto memory 段 + empty MEMORY.md 降级文案", async () => {
    const result = await runAskChild({
      home: workDir,
      cwd: workDir,
      enabled: true,
      question: "hello",
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.mockLog.length).toBeGreaterThanOrEqual(1);
    const sys = result.mockLog[0]?.systemSnippet ?? "";
    expect(sys).toContain("# auto memory");
    expect(sys).toContain("## Types of memory");
    expect(sys).toContain("<name>feedback</name>");
    expect(sys).toContain("## MEMORY.md");
    expect(sys).toContain("currently empty");
  }, 20_000);

  test("预置 MEMORY.md → 内容被加载到 system prompt", async () => {
    // 在 macOS 上 tmpdir 是 /var/... 但 Bun.spawn 的 cwd 会被 realpath 解析到
    // /private/var/...，nova-code 计算 memoryDir 时也用解析后的路径。测试要
    // 把 MEMORY.md 写到 nova-code 真正要读的位置 → 先 realpath 一下。
    const realWorkDir = await realpath(workDir);
    const memoryDir = join(
      realWorkDir,
      ".nova-code",
      "memory",
      "projects",
      computeProjectKey(realWorkDir),
    );
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      "- [User role](user_role.md) — go expert; new to react\n",
    );

    const result = await runAskChild({
      home: workDir,
      cwd: workDir,
      enabled: true,
      question: "explain react",
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const sys = result.mockLog[0]?.systemSnippet ?? "";
    expect(sys).toContain("[User role](user_role.md)");
    expect(sys).toContain("go expert");
  }, 20_000);

  test("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 → system prompt 不含 memory 段", async () => {
    const result = await runAskChild({
      home: workDir,
      cwd: workDir,
      enabled: false,
      question: "hello",
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const sys = result.mockLog[0]?.systemSnippet ?? "";
    expect(sys).not.toContain("# auto memory");
    expect(sys).not.toContain("## MEMORY.md");
  }, 20_000);
});

interface RunAskOptions {
  readonly home: string;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly question: string;
}

async function runAskChild(options: RunAskOptions): Promise<RunAskResult> {
  const mockLogFile = join(options.home, "mock.jsonl");
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask"],
    cwd: options.cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: options.home,
      USERPROFILE: options.home,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "chat",
      NOVA_MOCK_LOG_FILE: mockLogFile,
      ...(options.enabled ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(options.question);
  proc.stdin.end();

  const timeoutHandle = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const mockLog = await readMockLog(mockLogFile);
  return { exitCode, stdout, stderr, mockLog };
}

async function readMockLog(filePath: string): Promise<ReadonlyArray<MockLogEntry>> {
  try {
    const text = await Bun.file(filePath).text();
    const entries: MockLogEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        entries.push(JSON.parse(trimmed) as MockLogEntry);
      } catch {
        // skip malformed line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 用与 paths.ts:sanitizeProjectKey 完全一致的规则计算 project key —— 测试
 * 不能 import 内部 helper（私有），所以本地重做一次。规则：把 `/` 与 `\` 与 `:`
 * 替换为 `-`（leading `-` 保留）。
 *
 * 注意：测试 `workDir` 是 `mkdtemp(/var/...)` 返回的，macOS 上 tmpdir 是 `/var/...`
 * 软链接到 `/private/var/...`。findGitRootForMemory 内部用 path 比较，所以传入
 * 哪个路径就用哪个。我们传 workDir（未 realpath），所以 sanitize 也用 workDir。
 */
function computeProjectKey(absPath: string): string {
  return absPath.replaceAll(/[\\/:]+/g, "-");
}
