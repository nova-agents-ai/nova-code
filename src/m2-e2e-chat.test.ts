/**
 * m2-e2e-chat ——  chat 多轮 REPL 的子进程 + 本地 mock LLM 端到端测试。
 *
 * 覆盖设计稿 §10.2 的核心 DoD：
 * 1. 3 轮对话上下文不丢：第 3 轮请求里 messages 数组包含前 2 轮的 user/assistant
 * 2. /save alias-a 写出 <sessionId>.jsonl 和 alias-a.jsonl 两份文件
 * 3. /exit 正常返回退出码 0
 * 4. 再次以 --resume alias-a 启动，新一轮请求的 messages 包含恢复出的完整历史
 *
 * 设计取舍：
 * - Mock 走一个简单"每轮回固定文本、end_turn"的剧本——context 是否完整
 *   靠 mock 日志里的 messages.length 断言，不需要真实网络
 * - HOME 指向临时目录，确保 /save 写盘落在可清理的 sandbox 里，不污染真实 ~/.nova-code
 * - env 只保留最必要的几个变量，避免用户本机的 NOVA_ / ANTHROPIC_ 串进来
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** spawn chat 子进程并喂 stdin 全部行；等待退出后返回 stdout/stderr。 */
async function runChatChild(params: {
  readonly home: string;
  readonly mockLogFile: string;
  readonly args: readonly string[];
  readonly stdinLines: readonly string[];
  readonly timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "chat", ...params.args],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: params.home,
      USERPROFILE: params.home,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "chat",
      NOVA_MOCK_LOG_FILE: params.mockLogFile,
      // M16: disable auto memory for this M2 test so the per-turn relevance call
      // and end-of-turn extractor don't add extra mock entries the assertions
      // weren't designed for.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // 把所有 stdin 行一次性写入。**不**立刻 end()：若在 readline 消费完所有行前
  // EOF 到达，node:readline/promises 的后续 question() 会立即 reject，导致后几行丢失。
  // 让子进程的 /exit 自行控制退出时机，操作系统随进程退出自动关闭 stdin。
  const stdinBuf = new TextEncoder().encode(`${params.stdinLines.join("\n")}\n`);
  proc.stdin.write(stdinBuf);

  const timeoutHandle = setTimeout(() => proc.kill(), params.timeoutMs ?? 10_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

let home: string;
let mockLogFile: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m2e2e-"));
  mockLogFile = join(home, "mock-requests.jsonl");
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────────────────────────────────

describe("m2-e2e-chat", () => {
  test("3 轮对话 + /save alias + /exit → 历史完整透传，sessions/ 下有两份文件", async () => {
    const result = await runChatChild({
      home,
      mockLogFile,
      args: [],
      stdinLines: ["hello1", "hello2", "hello3", "/save alias-a", "/exit"],
    });

    expect(
      result.exitCode,
      `chat exited non-zero.\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    ).toBe(0);

    const logEntries = await readMockLogEntries(mockLogFile);
    expect(logEntries.length).toBe(3);
    expect(logEntries[0]?.messageCount).toBe(1);
    expect(logEntries[1]?.messageCount).toBe(3);
    expect(logEntries[2]?.messageCount).toBe(5);
    expect(logEntries[0]?.lastUserText).toBe("hello1");
    expect(logEntries[1]?.lastUserText).toBe("hello2");
    expect(logEntries[2]?.lastUserText).toBe("hello3");

    // ── /save 落盘：<sessionId>.jsonl + alias-a.jsonl ────────────
    const sessionsDir = join(home, ".nova-code", "sessions");
    const files = await readdir(sessionsDir);
    // 应有 alias-a.jsonl 以及一份 <sessionId>.jsonl
    expect(files).toContain("alias-a.jsonl");
    const sessionIdFile = files.find((f) => f !== "alias-a.jsonl" && f.endsWith(".jsonl"));
    expect(sessionIdFile, `sessionId jsonl not found in ${files.join(",")}`).toBeDefined();
    expect(sessionIdFile?.replace(/\.jsonl$/, "")).toMatch(UUID_V4_PATTERN);

    // alias 文件首行必须是 meta
    const aliasContent = await readFile(join(sessionsDir, "alias-a.jsonl"), "utf8");
    const firstLine = aliasContent.split("\n")[0] ?? "";
    expect(firstLine).toContain('"kind":"meta"');
    // 其后 6 行为 msg（3 user + 3 assistant）
    const msgLines = aliasContent
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(1);
    expect(msgLines.length).toBe(6);
  }, 15_000); // 整个子进程 + SSE 往返，给够宽松超时

  test("--resume alias-a 后新一轮 → 请求 messages 包含恢复出的 6 条历史 + 新 user", async () => {
    // 第一次会话：3 轮 + save
    const first = await runChatChild({
      home,
      mockLogFile,
      args: [],
      stdinLines: ["h1", "h2", "h3", "/save alias-b", "/exit"],
    });
    expect(
      first.exitCode,
      `first chat exited non-zero.\nstdout=${first.stdout}\nstderr=${first.stderr}`,
    ).toBe(0);
    expect(await readMockLogEntries(mockLogFile)).toHaveLength(3);

    // 清空 mock 日志，开始测 resume
    await clearMockLogFile(mockLogFile);

    // 第二次会话：--resume alias-b，喂 1 轮 + /exit
    const second = await runChatChild({
      home,
      mockLogFile,
      args: ["--resume", "alias-b"],
      stdinLines: ["follow-up", "/exit"],
    });
    expect(
      second.exitCode,
      `resume chat exited non-zero.\nstdout=${second.stdout}\nstderr=${second.stderr}`,
    ).toBe(0);

    const resumeLog = await readMockLogEntries(mockLogFile);
    expect(resumeLog.length).toBe(1);
    expect(resumeLog[0]?.messageCount).toBe(7);
    expect(resumeLog[0]?.lastUserText).toBe("follow-up");
  }, 15_000);

  test("idle 下双按 Ctrl+C → 退出码 130", async () => {
    // 注：不经 stdin 投投 “/exit”，才能停在 idle 等待输入的状态。
    // 非 TTY pipe 模式下 readline 不接管 SIGINT，SIGINT 由 process.on("SIGINT") 活
    // 用谁收——正好验证 SIGINT 状态机至少在 process 路径上不回归。TTY 路径
    // 由算——由代码同步注册 "rl.on('SIGINT', processSigintHandler)" 的简洁性保证。
    const proc = Bun.spawn({
      cmd: ["bun", "run", BIN_PATH, "chat"],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        USERPROFILE: home,
        NOVA_API_KEY: "sk-mock",
        NOVA_TRANSPORT: "mock",
        NOVA_MOCK_SCENARIO: "chat",
        NOVA_MOCK_LOG_FILE: mockLogFile,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const decoder = new TextDecoder();
    const stderrReader = proc.stderr.getReader();
    let stderrBuf = "";
    const waitFor = async (needle: string, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!stderrBuf.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for ${JSON.stringify(needle)} in stderr:\n${stderrBuf}`);
        }
        const { value, done } = await stderrReader.read();
        if (done) break;
        stderrBuf += decoder.decode(value, { stream: true });
      }
    };

    try {
      await waitFor("输入 /help 查看命令", 5_000);

      proc.kill("SIGINT");
      await waitFor("再按一次 Ctrl+C", 3_000);

      // 1.5s 窗口内再按一次
      proc.kill("SIGINT");

      const killTimer = setTimeout(() => proc.kill(), 8_000);
      const exitCode = await proc.exited;
      clearTimeout(killTimer);
      expect(exitCode).toBe(130);
    } finally {
      stderrReader.releaseLock();
    }
  }, 15_000);
});

interface MockLogEntry {
  readonly messageCount: number;
  readonly lastUserText: string | undefined;
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

async function clearMockLogFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
