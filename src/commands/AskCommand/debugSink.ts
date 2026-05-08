/**
 * ask 命令的 debug "汇"：把 AgentEvent 流追加到会话日志文件，不污染交互 stderr。
 *
 * 设计取舍：
 * - **不写 stderr**：debug 输出只入文件，用户仅在 stderr 看到 "log file: <path>" 一行提示
 * - 同步 IO（openSync/writeSync）：debug 量极小（每事件几百字节～几 KB），同步写
 *   保证事件顺序严格 = 时序顺序，避免 async 队列重排造成日志错位
 * - 'a' 模式追加：即使重名（同秒同 pid 极端情况）也不丢之前内容
 * - 文件名含 timestamp + pid：单进程一个文件、便于 ls -lt 看时序
 * - 创建失败 → 打印警告但**不阻断**主流程，降级为 NULL sink（debug 静默丢弃）
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getLogsDirPath } from "../../config/config.ts";

/**
 * 一个 debug "汇"：负责把单条 payload 写入会话日志文件。
 * 文件句柄通过 close() 关闭；非 debug 模式下用 NULL_DEBUG_SINK 占位（全部 no-op）。
 */
export interface DebugSink {
  readonly write: (payload: unknown) => void;
  readonly close: () => void;
  /** 日志文件路径；NULL sink 时为 null。仅供测试与提示用。 */
  readonly logFilePath: string | null;
}

export const NULL_DEBUG_SINK: DebugSink = {
  write: () => undefined,
  close: () => undefined,
  logFilePath: null,
};

export interface CreateFileDebugSinkOptions {
  /** 是否使用多行缩进 + 字符串内换行渲染。 */
  readonly pretty: boolean;
  /**
   * 预埋：一进程多会话时用作日志文件的后缀（替代 pid），避免互相覆盖。
   *
   * - M1.5 单 ask 调用：一个进程 = 一个会话，调用方不传，保持 pid 为后缀（向后兼容）。
   * - M2 chat REPL：一个进程承载多个会话，调用方传入各自的 sessionId。
   *
   * 预埋在这里而非沿用 pid 是因为 M2 时点再扩签名会引连锁改动；提前接口化成本极小。
   */
  readonly sessionId?: string;
}

/**
 * 创建一个 debug sink：把每条 payload 序列化后追加到日志文件。
 */
export function createFileDebugSink(options: CreateFileDebugSinkOptions): DebugSink {
  const logsDir = getLogsDirPath();
  const fileName = buildDebugLogFileName(new Date(), process.pid, options.sessionId);
  const filePath = join(logsDir, fileName);

  let fd: number;
  try {
    mkdirSync(logsDir, { recursive: true });
    fd = openSync(filePath, "a");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[debug] failed to open log file ${filePath}: ${reason}\n`);
    process.stderr.write("[debug] debug output will be discarded.\n");
    return NULL_DEBUG_SINK;
  }

  return {
    write: (payload) => {
      const text = formatDebugPayload(payload, options.pretty);
      // 文件落盘失败不应中断主流程；最坏情况是日志缺一条
      try {
        writeSync(fd, text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[debug] failed to append to log file: ${reason}\n`);
      }
    },
    close: () => {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败无需暴露给用户：进程退出时 OS 也会回收
      }
    },
    logFilePath: filePath,
  };
}

/**
 * 把 debug payload 序列化为日志文件中的文本块。
 *
 * 紧凑模式（pretty=false）：单行 `[debug] {json}\n`，便于 grep/jq 流式处理。
 *
 * 美化模式（pretty=true）：
 *   1. 多行缩进 JSON（2 空格）
 *   2. 字符串值里的 \n / \r / \t 渲染成真换行/制表（无需额外工具就能肉眼读多行文本）
 *   3. 事件之间加分隔线 `--- {type} ---`，便于扫读
 *
 * 美化模式下"渲染换行"的实现思路：
 *   JSON.stringify 会把真换行转义成 "\\n"；为了让最终文本里出现真换行，
 *   先在 replacer 里把字符串中的换行替换成一个稀有 sentinel，stringify 后
 *   再把 sentinel 还原为真字节。这样既保留了 JSON 结构（引号、缩进、键名），
 *   又能看到多行原文。
 *
 *   sentinel 选择：使用 Unicode 私有使用区（PUA，U+E000）作为分隔标记。
 *   关键是 **不能使用 C0 控制字符**（U+0000–U+001F）——JSON.stringify 会把
 *   这些字符强制转义成 `\uXXXX` 字面量（6 可见字符），导致 stringify 之后用
 *   原始字节 replaceAll 匹配不到，换行还原彻底失效。PUA 字符不在 JSON 强制
 *   转义范围内，也不会出现在正常文本中，两条约束同时满足。
 */
export function formatDebugPayload(payload: unknown, pretty: boolean): string {
  if (!pretty) {
    return `[debug] ${JSON.stringify(payload)}\n`;
  }

  const NEWLINE_SENTINEL = "\uE000NL\uE000";
  const TAB_SENTINEL = "\uE000TAB\uE000";
  const CR_SENTINEL = "\uE000CR\uE000";

  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value !== "string") return value;
    return value
      .replaceAll("\r\n", NEWLINE_SENTINEL)
      .replaceAll("\n", NEWLINE_SENTINEL)
      .replaceAll("\r", CR_SENTINEL)
      .replaceAll("\t", TAB_SENTINEL);
  };

  const json = JSON.stringify(payload, replacer, 2);
  const rendered = json
    .replaceAll(NEWLINE_SENTINEL, "\n")
    .replaceAll(CR_SENTINEL, "\r")
    .replaceAll(TAB_SENTINEL, "\t");

  const eventType =
    payload !== null && typeof payload === "object" && "type" in payload
      ? String((payload as { type: unknown }).type)
      : "event";

  return `--- ${eventType} ---\n${rendered}\n\n`;
}

/**
 * 构造日志文件名：
 *   - 未传 sessionId：`ask-YYYY-MM-DDTHH-mm-ss-<pid>.log`（M1.5 默认）
 *   - 传了 sessionId：`ask-YYYY-MM-DDTHH-mm-ss-<sessionId>.log`（M2 chat REPL 预留）
 *
 * 形如 ask-2026-05-01T15-11-23-42649.log，按字典序就是时序，便于排序定位。
 *
 * 抽成纯函数是为了可单测——内部 new Date() 不便注入。
 */
export function buildDebugLogFileName(now: Date, pid: number, sessionId?: string): string {
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  const ts =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const suffix = sessionId ?? String(pid);
  return `ask-${ts}-${suffix}.log`;
}
