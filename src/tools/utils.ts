/**
 * 工具系统共享 helper 与常量。
 *
 * 与 claude-code 顶层 `src/tools/utils.ts` 对齐 —— helper 集中在此而非散落到
 * `shared/` 子目录，避免过早抽象（M1 阶段尚无跨工具协调状态需求）。
 *
 * M1 步骤 1 现状：仅承载已有的 LSTool / FileReadTool 用到的常量与小 helper。
 * BashTool / FileEditTool / GrepTool / GlobTool 实施时会陆续补入：
 * - validateCwd（BashTool / GlobTool 共用）
 * - isIgnoredPath（GrepTool / GlobTool 共用）
 * - sanitizePathForMessage（错误消息脱敏，所有工具共用）
 * - SEARCH_IGNORE_DIRS（grep / glob 黑名单常量）
 * - 各工具的字节 / 时长 / 匹配数上限常量
 */

/** 单文件读取上限：1 MB。超过则截断并提示，避免把大文件灌进 context。 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** 目录列表上限：500 项。避免列出 node_modules 这种大目录把上下文撑爆。 */
export const MAX_DIR_ENTRIES = 500;

/** BashTool 输出（stdout + stderr 合并）上限：1 MB。超过则中段截断。 */
export const BASH_MAX_OUTPUT_BYTES = 1024 * 1024;

/** BashTool 默认超时：30 秒。 */
export const BASH_DEFAULT_TIMEOUT_MS = 30_000;

/** BashTool 超时上限：5 分钟。模型不允许传超过此值的 timeout_ms。 */
export const BASH_MAX_TIMEOUT_MS = 5 * 60_000;

/** SIGTERM 后等待子进程退出的窗口（毫秒）。到期未退则发 SIGKILL。 */
export const BASH_SIGTERM_GRACE_MS = 500;

/**
 * SIGKILL 后等待子进程退出的窗口（毫秒）。到期仍未退视为 zombie，detach 立即返回，
 * 父进程不再阻塞。详见 docs/design/M1-tools.md §4.1 v2.2 评审 · 测试 Issue #2。
 */
export const BASH_SIGKILL_GRACE_MS = 1000;

/**
 * FileWriteTool 单文件写入上限：5 MB。
 *
 * 远大于 FileReadTool 的 1 MB 读上限，因为模型可能生成较大的配置文件 / 模板；
 * 但 5 MB 已能拦住"不小心 dump 整个 base64 资产"等异常写入。详见
 * docs/design/M1-tools.md §五。
 */
export const WRITE_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * FileEditTool 单文件编辑上限：1 MB。与 FileReadTool 读上限对齐。
 *
 * edit 流程要把整文件读进内存做字符串替换，超大文件会让 V8 字符串操作变慢
 * 且不可中断。> 1 MB 的文件应改用 bash + sed/awk。详见 docs/design/M1-tools.md §五。
 */
export const EDIT_MAX_FILE_BYTES = 1024 * 1024;

/** GrepTool 单次返回的最大匹配条数。超过则截断并附 `[truncated, ...]` 提示。 */
export const GREP_MAX_MATCHES = 200;

/** GrepTool 单行最大字节数。超过则该行被截断显示，避免单行 base64 把上下文撑爆。 */
export const GREP_MAX_LINE_BYTES = 2_000;

/** GlobTool 单次返回的最大文件路径数。超过则提前 break 迭代，省 IO。 */
export const GLOB_MAX_RESULTS = 500;

/**
 * 工具范围常量集中入口（对外只读）。测试可以验证截断行为。
 *
 * 与 claude-code 同位置文件 `src/tools/utils.ts` 命名约定一致。后续 milestone
 * 引入新工具时，新增的常量也加入此对象，保持单一来源。
 */
export const TOOL_LIMITS = {
  maxFileBytes: MAX_FILE_BYTES,
  maxDirEntries: MAX_DIR_ENTRIES,
  bashMaxOutputBytes: BASH_MAX_OUTPUT_BYTES,
  bashDefaultTimeoutMs: BASH_DEFAULT_TIMEOUT_MS,
  bashMaxTimeoutMs: BASH_MAX_TIMEOUT_MS,
  bashSigtermGraceMs: BASH_SIGTERM_GRACE_MS,
  bashSigkillGraceMs: BASH_SIGKILL_GRACE_MS,
  writeMaxFileBytes: WRITE_MAX_FILE_BYTES,
  editMaxFileBytes: EDIT_MAX_FILE_BYTES,
  grepMaxMatches: GREP_MAX_MATCHES,
  grepMaxLineBytes: GREP_MAX_LINE_BYTES,
  globMaxResults: GLOB_MAX_RESULTS,
} as const;

/**
 * GrepTool / GlobTool 共享的目录黑名单。
 *
 * 路径遍历时若任一路径段精确等于此集合中的某项，则跳过该路径。详见
 * `isIgnoredPath` 与 docs/design/M1-tools.md §4.5。
 *
 * `.nova-code` 是本工具自家配置/日志目录（M3+ 引入），提前预留避免日后回流改动。
 */
export const SEARCH_IGNORE_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".venv",
  ".next",
  ".nova-code",
];

/**
 * 判断相对路径是否落在黑名单目录内。
 *
 * 语义：把 relPath 按 `/` 切分（跨平台统一用 posix 分隔，调用方应预先把
 * Windows 反斜杠转换为正斜杠或直接使用 path.posix），若**任一段**精确等于
 * `ignoreDirs` 中的某项即返回 true。
 *
 * 例（ignoreDirs=[".git", "node_modules"]）：
 * - `src/.git/HEAD`         → true（段 ".git" 精确匹配）
 * - `docs/git-notes.md`     → false（无段精确等于 ".git"）
 * - `a/node_modules/b.ts`   → true
 * - `my-node_modules/x.ts`  → false（段 "my-node_modules" 不等于 "node_modules"）
 * - `.git`                  → true（单段路径本身精确匹配）
 */
export function isIgnoredPath(
  relPath: string,
  ignoreDirs: readonly string[] = SEARCH_IGNORE_DIRS,
): boolean {
  if (relPath === "") return false;
  const segments = relPath.split("/").filter((s) => s !== "");
  for (const segment of segments) {
    if (ignoreDirs.includes(segment)) return true;
  }
  return false;
}

/**
 * 从工具入参中提取必填字符串字段，缺失或类型错误时抛 ToolExecutionError。
 * 把模型给的"不规范"参数转成清晰的错误信息，让模型自我纠正。
 *
 * 注意：本 helper 故意不依赖 Tool / ToolExecutionContext 等类型，纯做参数校验，
 * 避免 utils.ts 形成循环依赖。错误类型由调用方传入。
 */
import { ToolExecutionError } from "../errors/index.ts";

export function requireStringField(
  input: Readonly<Record<string, unknown>>,
  field: string,
  toolName: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || value === "") {
    throw new ToolExecutionError(
      toolName,
      `Missing required string field '${field}'. Got ${describeType(value)}.`,
    );
  }
  return value;
}

/** 把任意 unknown 错误描述为简短字符串，用于错误消息拼接。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 把任意 unknown 值描述为人类可读的类型名，用于错误消息拼接。 */
export function describeType(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 把绝对路径中的 $HOME 段替换为 `~`，仅用于错误消息 / 工具正常输出的脱敏，
 * 避免把用户名泄露到对话历史 / debug log。
 *
 * - bash 工具的 stdout/stderr **不**走此 helper（用户运行的命令产物不属于工具元数据）
 * - 路径不以 homedir 开头则原样返回
 *
 * 见 docs/design/M1-tools.md §六 错误消息脱敏 + v1.4 修复。
 */
import { homedir } from "node:os";

export function sanitizePathForMessage(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/**
 * 校验并解析工具入参里的 cwd 字段（5 个分支，行为见设计稿 §4.1 cwd 校验表）。
 *
 * @param cwd 工具入参原始值（可能为 undefined / 字符串 / 其他）
 * @param toolName 抛错时附带的工具名
 * @returns 解析后的绝对路径（cwd 未传时返回 process.cwd()）
 * @throws ToolExecutionError 当 cwd 不存在 / 非目录 / 无读权限
 */
import { access, constants as fsConstants, stat as fsStat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export async function validateCwd(cwd: unknown, toolName: string): Promise<string> {
  if (cwd === undefined || cwd === null) return process.cwd();

  if (typeof cwd !== "string") {
    throw new ToolExecutionError(
      toolName,
      `cwd must be a string. Got ${describeType(cwd)}.`,
    );
  }

  const absolute = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
  const sanitized = sanitizePathForMessage(absolute);

  let info: Awaited<ReturnType<typeof fsStat>>;
  try {
    info = await fsStat(absolute);
  } catch (error) {
    throw new ToolExecutionError(
      toolName,
      `cwd does not exist: ${sanitized}`,
      { cause: error },
    );
  }

  if (!info.isDirectory()) {
    throw new ToolExecutionError(toolName, `cwd is not a directory: ${sanitized}`);
  }

  try {
    await access(absolute, fsConstants.R_OK);
  } catch (error) {
    throw new ToolExecutionError(
      toolName,
      `cwd not accessible: ${sanitized}`,
      { cause: error },
    );
  }

  return absolute;
}
