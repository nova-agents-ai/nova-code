/**
 * BashTool（name: "Bash"）—— 在 /bin/sh -c 下执行 shell 命令。
 *
 * 设计稿：docs/design/M1-tools.md §4.1（含 v2.2 评审 · 测试 Issue #2 zombie
 * detach grace + v2.2 评审 · 架构 Issue #3 输出格式正则可解析性约束）。
 *
 * 关键不变量：
 * 1. 工具不阻塞 agent loop —— 超时三段式 SIGTERM(500ms) → SIGKILL(1000ms) →
 *    detach + 立即返回，永不 hang
 * 2. 输出格式严格规范化 —— 6 条 regex 约束（见 §4.1），让模型可正则解析退出码
 * 3. 安全 —— 硬黑名单立即拒绝，软警告嵌入 result 前缀让模型自己判断
 *
 * M1 范围内不做：
 * - cwd 路径白名单（M3 权限系统）
 * - 内容过滤 / 密钥脱敏（M3）
 * - 流式输出回传（M5+）
 */

import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import type { Tool, ToolExecutionContext } from "../../Tool.ts";
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_OUTPUT_BYTES,
  BASH_MAX_TIMEOUT_MS,
  BASH_SIGKILL_GRACE_MS,
  BASH_SIGTERM_GRACE_MS,
  describeError,
  describeType,
  requireStringField,
  validateCwd,
} from "../utils.ts";

const TOOL_NAME = "Bash";

// ────────────────────────────────────────────────────────────────────────────
// 安全过滤：硬黑名单（命中即拒绝） + 软警告（命中后嵌入 result 前缀）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 硬黑名单 —— 命中即抛 ToolExecutionError，命令完全不执行。
 *
 * M1 只做"灾难拦截"最小集，避免误触毁电脑。完整黑名单策略由 M3 权限系统接管。
 */
const HARD_BANNED_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "rm-rf-root", pattern: /\brm\s+(-[rRfF]+\s+)+\/(\s|$)/ },
  { name: "rm-rf-root-glob", pattern: /\brm\s+(-[rRfF]+\s+)+\/\*/ },
  { name: "dd-to-disk", pattern: /\bdd\s+.*\bof=\/dev\/(sd|nvme|disk)/ },
  { name: "mkfs", pattern: /\bmkfs\b/ },
  { name: "redirect-to-disk", pattern: />\s*\/dev\/sd[a-z]/ },
  { name: "fork-bomb", pattern: /:\(\)\{\s*:\|:&\s*\};:/ },
];

/**
 * 软警告 —— 命中后将警告嵌入 result 前缀返回给模型，但仍执行命令。
 *
 * 见 §4.1 "为什么把警告嵌入 result"段：让模型自己判断是否需要纠正。
 */
const SOFT_WARN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "curl-pipe-shell", pattern: /\b(curl|wget)\s+[^|]*\|\s*(sh|bash|zsh)\b/ },
  { name: "sudo", pattern: /\bsudo\b/ },
  { name: "remote-write", pattern: /\b(scp|rsync)\s+\S+\s+\S+:/ },
];

function checkHardBlacklist(command: string): { readonly name: string } | null {
  for (const entry of HARD_BANNED_PATTERNS) {
    if (entry.pattern.test(command)) return { name: entry.name };
  }
  return null;
}

function checkSoftWarnings(command: string): readonly string[] {
  const matched: string[] = [];
  for (const entry of SOFT_WARN_PATTERNS) {
    if (entry.pattern.test(command)) matched.push(entry.name);
  }
  return matched;
}

// ────────────────────────────────────────────────────────────────────────────
// 输出截断
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把字节超过 maxBytes 的内容做"前 50% + 中段标记 + 后 50%"截断。
 *
 * 与 §4.1 输出格式约束 3（截断标记 regex）严格匹配：
 *   /^\.\.\. \(truncated (\d+) bytes\) \.\.\.$/m
 */
function truncateOutput(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength <= maxBytes) return content;

  const head = Math.floor(maxBytes / 2);
  const tail = maxBytes - head;
  const droppedBytes = buf.byteLength - maxBytes;

  // 按字节切，再 toString —— 末尾可能切坏一个 utf8 字符，但 Node Buffer.toString
  // 默认行为是替换为 U+FFFD，对 LLM 解析无影响
  const headPart = buf.subarray(0, head).toString("utf8");
  const tailPart = buf.subarray(buf.byteLength - tail).toString("utf8");

  return `${headPart}\n... (truncated ${droppedBytes} bytes) ...\n${tailPart}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 子进程执行：超时三段式 + zombie detach grace
// ────────────────────────────────────────────────────────────────────────────

interface SpawnOutcome {
  readonly stdout: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly killedByTimeout: boolean;
  readonly zombiePid: number | null;
}

/**
 * spawn /bin/sh -c command 并捕获合并输出，按"超时三段式"管理生命周期：
 *   1. 正常等待 child exit
 *   2. 到 timeoutMs → SIGTERM；BASH_SIGTERM_GRACE_MS 后仍未退 → SIGKILL
 *   3. SIGKILL 后 BASH_SIGKILL_GRACE_MS 仍未退 → child.unref() 并 resolve（zombie）
 *   4. abort signal 同样走 SIGTERM → SIGKILL → detach 流程，但抛 AbortError
 *
 * 见 docs/design/M1-tools.md §4.1 v2.2 评审 · 测试 Issue #2。
 */
function spawnAndWait(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new ToolExecutionError(TOOL_NAME, `Failed to spawn /bin/sh: ${describeError(error)}`, {
          cause: error,
        }),
      );
      return;
    }

    const childPid = child.pid ?? -1;
    const outputChunks: Buffer[] = [];
    let totalBytes = 0;
    const captureLimit = BASH_MAX_OUTPUT_BYTES * 2; // 多收一倍，截断逻辑由 truncateOutput 处理

    function captureChunk(chunk: Buffer): void {
      if (totalBytes >= captureLimit) return;
      const remaining = captureLimit - totalBytes;
      if (chunk.byteLength <= remaining) {
        outputChunks.push(chunk);
        totalBytes += chunk.byteLength;
      } else {
        outputChunks.push(chunk.subarray(0, remaining));
        totalBytes = captureLimit;
      }
    }

    child.stdout.on("data", (chunk: Buffer) => captureChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => captureChunk(chunk));

    let killedByTimeout = false;
    let abortRequested = false;
    let detached = false;
    let settled = false;
    let sigtermTimer: ReturnType<typeof setTimeout> | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    let detachTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function clearAllTimers(): void {
      if (sigtermTimer !== null) clearTimeout(sigtermTimer);
      if (sigkillTimer !== null) clearTimeout(sigkillTimer);
      if (detachTimer !== null) clearTimeout(detachTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      sigtermTimer = null;
      sigkillTimer = null;
      detachTimer = null;
      timeoutTimer = null;
    }

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      clearAllTimers();
      signal.removeEventListener("abort", onAbort);
      action();
    }

    function startKillSequence(): void {
      // SIGTERM
      try {
        child.kill("SIGTERM");
      } catch {
        // 子进程可能已退出，忽略
      }
      // 500ms 后 SIGKILL
      sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 同上
        }
        // 1000ms 后仍未退 → detach + 立即 settle
        detachTimer = setTimeout(() => {
          if (settled) return;
          detached = true;
          try {
            child.unref();
          } catch {
            // 极罕见 spawn 后 child 句柄异常，忽略
          }
          // 主动触发 settle 路径（与 child.on("close") 等价）
          finishWithOutcome();
        }, BASH_SIGKILL_GRACE_MS);
      }, BASH_SIGTERM_GRACE_MS);
    }

    function onAbort(): void {
      if (abortRequested || settled) return;
      abortRequested = true;
      startKillSequence();
    }

    if (signal.aborted) {
      // 启动前已 abort —— 立即拒绝
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new AbortError("BashTool aborted before execution started."));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    // 超时定时器
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      killedByTimeout = true;
      startKillSequence();
    }, timeoutMs);

    function finishWithOutcome(): void {
      const stdout = Buffer.concat(outputChunks).toString("utf8");
      const durationMs = Date.now() - startedAt;
      // exitCode 优先取 child.exitCode；若被信号杀且 detach 时 child.exitCode 仍为 null，
      // 给一个 -1 标记（regex 约束 1 允许负数）
      let exitCode: number;
      if (child.exitCode !== null) {
        exitCode = child.exitCode;
      } else if (child.signalCode !== null) {
        // 信号杀死：负数表示信号，符合约束 1 的 /-?\d+/
        exitCode = -1;
      } else {
        exitCode = -1;
      }
      const outcome: SpawnOutcome = {
        stdout,
        exitCode,
        durationMs,
        killedByTimeout,
        zombiePid: detached ? childPid : null,
      };

      settle(() => {
        if (abortRequested && !killedByTimeout) {
          // 用户主动中断 —— 抛 AbortError
          const suffix = detached ? ` (zombie pid=${childPid} detached)` : "";
          reject(new AbortError(`BashTool aborted by user.${suffix}`));
        } else {
          resolve(outcome);
        }
      });
    }

    child.on("close", () => {
      if (settled) return;
      finishWithOutcome();
    });

    child.on("error", (error) => {
      if (settled) return;
      settle(() => {
        reject(
          new ToolExecutionError(TOOL_NAME, `Failed to spawn /bin/sh: ${describeError(error)}`, {
            cause: error,
          }),
        );
      });
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool 导出
// ────────────────────────────────────────────────────────────────────────────

export const BashTool: Tool = {
  name: TOOL_NAME,
  description:
    "Execute a shell command via /bin/sh -c. Returns combined stdout+stderr, " +
    "exit code, and duration. Output is truncated if it exceeds " +
    `${BASH_MAX_OUTPUT_BYTES} bytes. Default timeout is ${BASH_DEFAULT_TIMEOUT_MS}ms ` +
    `(max ${BASH_MAX_TIMEOUT_MS}ms). Optional cwd parameter sets the working directory. ` +
    "Dangerous commands like 'rm -rf /' are rejected by a safety filter.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute. Runs in /bin/sh -c.",
      },
      timeout_ms: {
        type: "number",
        description: `Optional timeout in milliseconds. Default ${BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS}.`,
      },
      cwd: {
        type: "string",
        description:
          "Optional working directory (absolute or relative to process cwd). Defaults to process cwd.",
      },
    },
    required: ["command"],
  },
  requiresApproval: true,
  execute: async (input, context: ToolExecutionContext) => {
    const command = requireStringField(input, "command", TOOL_NAME);
    const timeoutMs = parseTimeout(input["timeout_ms"]);
    const cwd = await validateCwd(input["cwd"], TOOL_NAME);

    const hardHit = checkHardBlacklist(command);
    if (hardHit !== null) {
      throw new ToolExecutionError(TOOL_NAME, `Command rejected by safety filter: ${hardHit.name}`);
    }

    const softWarnings = checkSoftWarnings(command);
    const outcome = await spawnAndWait(command, cwd, timeoutMs, context.signal);

    return composeOutput(command, outcome, softWarnings, timeoutMs);
  },
};

function parseTimeout(value: unknown): number {
  if (value === undefined || value === null) return BASH_DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ToolExecutionError(
      TOOL_NAME,
      `timeout_ms must be a positive finite number. Got ${describeType(value)}.`,
    );
  }
  if (value > BASH_MAX_TIMEOUT_MS) {
    throw new ToolExecutionError(
      TOOL_NAME,
      `timeout_ms ${value} exceeds maximum ${BASH_MAX_TIMEOUT_MS}.`,
    );
  }
  return Math.floor(value);
}

/**
 * 拼装输出。把 timeoutMs 作为参数传入，避免 formatBashOutput 内部反推。
 * 与 §4.1 输出格式约束 1-6 严格匹配。
 */
function composeOutput(
  command: string,
  outcome: SpawnOutcome,
  softWarnings: readonly string[],
  timeoutMs: number,
): string {
  const truncated = truncateOutput(outcome.stdout, BASH_MAX_OUTPUT_BYTES);
  const lines: string[] = [];

  if (softWarnings.length > 0) {
    // 约束 4：软警告前缀
    lines.push(`[warning] command matched soft-warn patterns: ${softWarnings.join(", ")}`);
  }
  // 约束 2：首行 `$ <command>`
  lines.push(`$ ${command}`);
  if (truncated.length > 0) lines.push(truncated);
  if (outcome.zombiePid !== null) {
    // 约束 6：zombie warning（v2.2 评审 · 测试 Issue #2）
    lines.push(`[warning] child likely zombie, pid=${outcome.zombiePid}, detached after SIGKILL`);
  }
  if (outcome.killedByTimeout) {
    // 约束 5：超时标记
    lines.push(`[killed: timeout after ${timeoutMs}ms]`);
  }
  // 约束 1：尾行 [exit code: N] [duration: Xms]
  lines.push(`[exit code: ${outcome.exitCode}] [duration: ${outcome.durationMs}ms]`);

  return lines.join("\n");
}
