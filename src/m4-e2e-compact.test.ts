/**
 * m4-e2e-compact —— M4 上下文压缩 + CLAUDE.md 注入端到端测试。
 *
 * 4 条用例：
 *   a) 自动 compact：mock 把 usage 拉到阈值之上，第二轮请求 messages 应被替换为
 *      [summary_user_message]
 *   b) /compact 手动：3 轮对话后输入 /compact，stderr 出现 "[compact] done" 进度
 *   c) 50 轮不超限：连续 50 轮 chat scenario，进程 0 退出（autoCompact 兜底）
 *   d) CLAUDE.md 注入：HOME 临时目录写 CLAUDE.md（含 @include 子文件），
 *      第一轮请求的 system 字段应包含两份内容
 *
 * 与 m2-e2e-chat 同款工艺：子进程 + NOVA_TRANSPORT=mock + 落盘的 mock log 断言。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runChatChild(params: {
  readonly home: string;
  readonly mockLogFile: string;
  readonly args: readonly string[];
  readonly stdinLines: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Promise<RunResult> {
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
      // M16: existing M4 compact e2e doesn't account for memory's per-turn relevance
      // selector / end-of-turn extractor; disable to keep assertions stable.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...(params.extraEnv ?? {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdinBuf = new TextEncoder().encode(`${params.stdinLines.join("\n")}\n`);
  proc.stdin.write(stdinBuf);

  const timeoutHandle = setTimeout(() => proc.kill(), params.timeoutMs ?? 30_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

interface MockLogEntry {
  readonly messageCount: number;
  readonly lastUserText: string | undefined;
  readonly hasTools: boolean;
  readonly toolChoiceType?: string;
  readonly systemSnippet?: string;
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

let home: string;
let mockLogFile: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m4e2e-"));
  mockLogFile = join(home, "mock-requests.jsonl");
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("m4-e2e-compact", () => {
  test("a) 自动 compact：超阈值 → 下一轮 messages 被替换为单条 summary user", async () => {
    // 把 mock 的 usage 拉到 168K（阈值是 167K）→ 第一轮 assistant message 携带
    // 超阈值 usage，下一轮 sendTurn 进入 streamOneTurn 前会触发 autoCompactIfNeeded。
    const result = await runChatChild({
      home,
      mockLogFile,
      args: [],
      stdinLines: ["q1", "q2", "/exit"],
      extraEnv: { NOVA_MOCK_INFLATE_USAGE: "168000" },
    });
    expect(result.exitCode, `exitCode != 0\nstdout=${result.stdout}\nstderr=${result.stderr}`).toBe(
      0,
    );

    // stderr 应出现 [compact] auto-compacting 提示
    expect(result.stderr).toContain("[compact] auto-compacting");
    expect(result.stderr).toContain("[compact] done");

    const log = await readMockLogEntries(mockLogFile);
    // 期望至少 3 条 LLM 调用：q1（chat）+ compact（无 tools）+ q2（chat）
    expect(log.length).toBeGreaterThanOrEqual(3);
    // 找到 compact 请求：forked-agent 对齐后它会复用 tools，并以 tool_choice:none 禁工具。
    const compactReq = log.find(
      (e) => e.lastUserText?.includes("Your task is to create a detailed summary") === true,
    );
    expect(compactReq, `no compact request found in log:\n${JSON.stringify(log)}`).toBeDefined();
    expect(compactReq?.hasTools).toBe(true);
    expect(compactReq?.toolChoiceType).toBe("none");
  }, 30_000);

  test("b) /compact 手动 → stderr 出现 [compact] done", async () => {
    const result = await runChatChild({
      home,
      mockLogFile,
      args: [],
      stdinLines: ["hello1", "hello2", "/compact focus on api", "/exit"],
    });
    expect(result.exitCode, `exitCode != 0\nstdout=${result.stdout}\nstderr=${result.stderr}`).toBe(
      0,
    );
    // 用户能看到压缩完成提示
    expect(result.stderr.includes("已压缩") || result.stderr.includes("compact")).toBeTruthy();

    const log = await readMockLogEntries(mockLogFile);
    // 至少 3 条：hello1 / hello2 / compact 请求
    expect(log.length).toBeGreaterThanOrEqual(3);
    const compactReq = log.find(
      (e) => e.lastUserText?.includes("Your task is to create a detailed summary") === true,
    );
    expect(compactReq).toBeDefined();
    expect(compactReq?.hasTools).toBe(true);
    expect(compactReq?.toolChoiceType).toBe("none");
    // 自定义指令应在 compact 请求里出现：sketch 检查 lastUserText 包含 "focus on api"
    if (compactReq?.lastUserText !== undefined) {
      expect(compactReq.lastUserText).toContain("focus on api");
    }
  }, 30_000);

  test("c) 50 轮不超限 + 自动 compact 多次 → 0 退出", async () => {
    const lines = [];
    for (let i = 0; i < 50; i += 1) lines.push(`m${i}`);
    lines.push("/exit");
    const result = await runChatChild({
      home,
      mockLogFile,
      args: [],
      stdinLines: lines,
      // 拉 usage 略超阈值 → autoCompact 会反复触发；但有 circuit breaker 兜底
      extraEnv: { NOVA_MOCK_INFLATE_USAGE: "170000" },
      timeoutMs: 90_000,
    });
    expect(
      result.exitCode,
      `exitCode != 0 after 50 turns\nstderr (tail)=${result.stderr.slice(-2000)}`,
    ).toBe(0);
  }, 120_000);

  test("d) CLAUDE.md（含 @include）注入到 system 字段", async () => {
    // 把 home 当作 cwd 的 git 仓库根：HOME 下创建 CLAUDE.md + extra.md
    // 但 chat 启动时是用 process.cwd()，HOME 路径不会进 project 层；
    // 我们让 user 层（~/.nova-code/CLAUDE.md）+ @include 都在 HOME 里。
    await Bun.write(join(home, ".nova-code", "CLAUDE.md"), "USER_LAYER_CONTENT\n@./extra.md");
    await Bun.write(join(home, ".nova-code", "extra.md"), "INCLUDED_EXTRA_CONTENT");

    const result = await runChatChild({
      home,
      mockLogFile,
      args: [],
      stdinLines: ["greet", "/exit"],
    });
    expect(result.exitCode, `exitCode != 0\nstderr=${result.stderr}`).toBe(0);

    const log = await readMockLogEntries(mockLogFile);
    expect(log.length).toBeGreaterThanOrEqual(1);
    const firstReq = log[0];
    expect(firstReq?.systemSnippet ?? "").toContain("USER_LAYER_CONTENT");
    expect(firstReq?.systemSnippet ?? "").toContain("INCLUDED_EXTRA_CONTENT");
  }, 30_000);
});
