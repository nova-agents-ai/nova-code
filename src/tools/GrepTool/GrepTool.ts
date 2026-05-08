/**
 * GrepTool（name: "Grep"）—— 在文件树中搜索匹配正则的行。
 *
 * 设计要点（详见 docs/design/M1-tools.md §4.4）：
 *
 * 1. **优先 ripgrep**：进程级 lazy + cached 检测；存在则 spawn("rg", [...])
 * 2. **fallback Node 实现**：rg 不可用时**或** rg 运行时异常时（exitCode ∉ {0,1}）
 *    立即降级走 Node 实现。同次调用内仅降级一次
 * 3. **黑名单目录**：自动跳过 SEARCH_IGNORE_DIRS（任一路径段精确匹配即跳过）
 * 4. **截断**：匹配数 > GREP_MAX_MATCHES 截断；单行 > GREP_MAX_LINE_BYTES 截断该行
 * 5. **测试钩子**：暴露 `_resetRipgrepCache()` 仅供单测，避免测试间状态污染
 *
 * 不读 .gitignore（M1 简化）：黑名单覆盖 95% 噪音目录，剩余的 .gitignore 解析
 * 留 M3+ 评估。
 */

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Tool } from "../../Tool.ts";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import {
  describeError,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  isIgnoredPath,
  requireStringField,
  sanitizePathForMessage,
  SEARCH_IGNORE_DIRS,
} from "../utils.ts";

const TOOL_NAME = "Grep";

/** 单次 grep 命中的一条记录。 */
interface GrepMatch {
  /** 相对 cwd 的路径，使用 posix `/` 分隔（跨平台一致）。 */
  relativePath: string;
  /** 1-indexed 行号。 */
  lineNumber: number;
  /** 匹配的整行内容（可能被截断到 GREP_MAX_LINE_BYTES）。 */
  line: string;
}

// =================== ripgrep 检测缓存 ===================

/**
 * 进程级 lazy cache：
 * - undefined：尚未检测
 * - string：rg 可用，值为 binary 路径（M1 仅记录 "rg" 占位，未来可扩展为绝对路径）
 * - null：rg 不可用，永久 fallback
 */
let ripgrepPath: string | null | undefined = undefined;

/** 仅供测试使用：重置 ripgrep 检测缓存，避免测试间状态污染。 */
export function _resetRipgrepCache(): void {
  ripgrepPath = undefined;
}

/** 异步检测 ripgrep 是否可用。检测期间不抛错，永远 resolve。 */
async function detectRipgrep(): Promise<string | null> {
  if (ripgrepPath !== undefined) return ripgrepPath;
  ripgrepPath = await tryDetectRipgrep();
  return ripgrepPath;
}

function tryDetectRipgrep(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    try {
      const child = spawn("rg", ["--version"], { stdio: "ignore" });
      child.once("error", () => settle(null));
      child.once("exit", (code) => settle(code === 0 ? "rg" : null));
    } catch {
      settle(null);
    }
  });
}

// =================== 工具定义 ===================

export const GrepTool: Tool = {
  name: TOOL_NAME,
  description:
    "Search file contents using a regular expression. Recursively walks the search " +
    "directory, automatically skipping common ignored directories (.git, node_modules, " +
    "dist, build, .venv, .next, .nova-code). Uses ripgrep when available, falls back " +
    `to a Node implementation otherwise. Returns at most ${GREP_MAX_MATCHES} matches; ` +
    `lines longer than ${GREP_MAX_LINE_BYTES} bytes are truncated.`,
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Regex pattern (JavaScript regex syntax). Examples: 'TODO', '^export ', 'function\\s+\\w+'.",
      },
      path: {
        type: "string",
        description: "Directory to search. Defaults to process cwd.",
      },
      include: {
        type: "string",
        description:
          "Glob filter for filenames (e.g. '*.ts', '*.{js,ts}'). Optional. Applied to basenames.",
      },
      case_sensitive: {
        type: "boolean",
        description: "If true, regex is case-sensitive. Default false.",
      },
    },
    required: ["pattern"],
  },
  execute: async (input, context) => {
    const pattern = requireStringField(input, "pattern", TOOL_NAME);
    const caseSensitive = readBoolInput(input, "case_sensitive");
    const include = readOptionalStringInput(input, "include");
    const searchRoot = await resolveSearchRoot(input["path"]);

    // 提前编译正则，捕获语法错误
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? "" : "i");
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Invalid regex '${pattern}': ${describeError(error)}`,
        { cause: error },
      );
    }

    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted before search`);
    }

    const args: GrepArgs = {
      pattern,
      regex,
      caseSensitive,
      include,
      searchRoot,
      signal: context.signal,
    };

    // 路径决策：rg 可用 → 先尝试 rg；rg 异常 → fallback 一次
    const rgAvailable = await detectRipgrep();
    let result: GrepResult;
    if (rgAvailable) {
      const rgResult = await runRipgrep(args);
      result = rgResult.kind === "ok" ? rgResult : await runNodeGrep(args);
    } else {
      result = await runNodeGrep(args);
    }

    // 子进程结束后再做一次 abort 检查（abort 路径下 runRipgrep 返回空 ok，需要在此抛错）
    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted during search`);
    }

    return formatOutput(result, searchRoot);
  },
};

// =================== 通用类型 ===================

interface GrepArgs {
  pattern: string;
  regex: RegExp;
  caseSensitive: boolean;
  include: string | undefined;
  /** 绝对路径搜索根。 */
  searchRoot: string;
  signal: AbortSignal;
}

type GrepResult =
  | { kind: "ok"; matches: GrepMatch[]; truncated: boolean; totalScanned: number }
  | { kind: "error"; reason: string };

// =================== ripgrep 路径 ===================

/** rg 子进程 stdout 硬上限：超过即 kill，避免 OOM。8 MB 远大于 200 匹配×2KB 的理论上限。 */
const RIPGREP_STDOUT_HARD_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Node fallback 单文件扫描上限：5 MB。超过则跳过该文件。
 * 5 MB 覆盖绝大部分源码文件，避免被 lock 文件 / 编译产物 / 大日志文件 OOM。
 */
const NODE_GREP_FILE_SCAN_LIMIT_BYTES = 5 * 1024 * 1024;

/** 调用 rg 子进程。返回 ok（含匹配 / 无匹配）或 error（运行时异常需要 fallback）。 */
function runRipgrep(args: GrepArgs): Promise<GrepResult> {
  return new Promise((resolvePromise) => {
    const rgArgs: string[] = [
      "--line-number",
      "--no-heading",
      "--with-filename",
      "--color=never",
      // 用 \0 分隔 path/line/content，避免文件名中含 ":" 时解析歧义
      "--null",
      // 与 Node 路径行为一致：使用 SEARCH_IGNORE_DIRS 而非 .gitignore
      "--no-ignore",
      "--hidden",
    ];
    // 每个黑名单目录排两个 glob：目录入口本身 + 内部所有路径
    for (const dir of SEARCH_IGNORE_DIRS) {
      rgArgs.push("--glob", `!**/${dir}`);
      rgArgs.push("--glob", `!**/${dir}/**`);
    }
    if (!args.caseSensitive) rgArgs.push("--ignore-case");
    if (args.include) rgArgs.push("--glob", args.include);
    // 单行字节上限
    rgArgs.push("--max-columns", String(GREP_MAX_LINE_BYTES));
    // 注意：--max-count 是 per-file 上限，不是总数上限。总数上限通过 parseRipgrepOutput
    // 提前 break 实现。这里设一个宽松的 per-file 上限避免单文件刷屏（同时不超 GREP_MAX_MATCHES）。
    rgArgs.push("--max-count", String(GREP_MAX_MATCHES));
    // 正则与搜索根
    rgArgs.push("--regexp", args.pattern, args.searchRoot);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", rgArgs);
    } catch (error) {
      resolvePromise({
        kind: "error",
        reason: `spawn rg failed: ${describeError(error)}`,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let killedForOversize = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= RIPGREP_STDOUT_HARD_LIMIT_BYTES) {
        stdoutChunks.push(chunk);
      } else if (!killedForOversize) {
        killedForOversize = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 32) stderrChunks.push(chunk);
    });

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    args.signal.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const settle = (value: GrepResult) => {
      if (settled) return;
      settled = true;
      args.signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };

    child.once("error", (error) => {
      settle({ kind: "error", reason: `rg child error: ${describeError(error)}` });
    });

    child.once("close", (code) => {
      if (args.signal.aborted) {
        // abort 不视为 rg 异常，返回空 ok（上层 execute 会再次检查 signal 并抛 AbortError）
        settle({ kind: "ok", matches: [], truncated: false, totalScanned: 0 });
        return;
      }
      if (killedForOversize) {
        // 超 stdout 硬上限，按已收到的数据解析（截断），不当成异常
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const matches = parseRipgrepNullOutput(stdout, args.searchRoot);
        settle({ kind: "ok", matches, truncated: true, totalScanned: -1 });
        return;
      }
      // ripgrep 退出码语义：0 有匹配；1 无匹配；其他视为运行时异常 → 触发 fallback
      if (code !== 0 && code !== 1) {
        const stderrPreview = Buffer.concat(stderrChunks).toString("utf8").slice(0, 200);
        settle({
          kind: "error",
          reason: `rg exit ${code}: ${stderrPreview}`,
        });
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const matches = parseRipgrepNullOutput(stdout, args.searchRoot);
      settle({
        kind: "ok",
        matches,
        truncated: matches.length >= GREP_MAX_MATCHES,
        totalScanned: -1, // rg 路径不统计扫描文件数
      });
    });
  });
}

/**
 * 解析 `rg --null` 输出。每条记录格式：`<path>\0<line-no>:<content>\n`
 *
 * `--null` 让 rg 用 NUL 字节分隔文件名与"行号 + 内容"，避免文件名含 `:` 时歧义。
 * 行号与内容之间仍是 `:` —— 但行号必为数字，定位第一个 `:` 即可。
 */
function parseRipgrepNullOutput(stdout: string, searchRoot: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  const lines = stdout.split("\n");
  for (const raw of lines) {
    if (raw === "") continue;
    if (matches.length >= GREP_MAX_MATCHES) break;
    const nul = raw.indexOf("\u0000");
    if (nul === -1) continue;
    const absPath = raw.slice(0, nul);
    const rest = raw.slice(nul + 1);
    const colon = rest.indexOf(":");
    if (colon === -1) continue;
    const lineNo = Number.parseInt(rest.slice(0, colon), 10);
    if (!Number.isFinite(lineNo)) continue;
    const content = rest.slice(colon + 1);
    matches.push({
      relativePath: toRelativePosix(absPath, searchRoot),
      lineNumber: lineNo,
      line: truncateLine(content),
    });
  }
  return matches;
}

// =================== Node fallback 路径 ===================

// 纯 Node 实现的 grep。递归遍历 searchRoot，跳过 SEARCH_IGNORE_DIRS，
// 对每个文件按行匹配 regex，命中即记录。命中数达到 GREP_MAX_MATCHES 即提前终止。
//
// include glob：支持 Bun.Glob 全部语法，常见示例 `*.ts` / `*.{ts,js}` /
// 双星号通配符 + `/*.ts`。借助 `Bun.Glob` 直接做 basename / 相对路径匹配。
//
// 注意：上方刻意使用行注释而非 JSDoc 块注释 —— 因为示例里的双星号 + `/*` 序列
// 会让块注释提前在 `*/` 处终止，触发 Bun 解析器报"Unexpected *"错误。
async function runNodeGrep(args: GrepArgs): Promise<GrepResult> {
  const matches: GrepMatch[] = [];
  let totalScanned = 0;
  const includeMatcher = args.include ? buildIncludeMatcher(args.include) : null;

  async function walk(dir: string): Promise<void> {
    if (matches.length >= GREP_MAX_MATCHES) return;
    if (args.signal.aborted) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 不存在的子目录跳过，不阻断整体搜索
    }

    for (const entry of entries) {
      if (matches.length >= GREP_MAX_MATCHES) return;
      if (args.signal.aborted) return;

      const entryName = String(entry.name);
      const absPath = `${dir}${sep}${entryName}`;
      const relPath = toRelativePosix(absPath, args.searchRoot);
      if (isIgnoredPath(relPath)) continue;

      if (entry.isDirectory()) {
        await walk(absPath);
      } else if (entry.isFile()) {
        if (includeMatcher && !includeMatcher(relPath, entryName)) continue;
        await scanFile(absPath, relPath);
        totalScanned += 1;
      }
      // 其他类型（symlink / socket）跳过
    }
  }

  async function scanFile(absPath: string, relPath: string): Promise<void> {
    // 大小预检：> NODE_GREP_FILE_SCAN_LIMIT_BYTES 的文件直接跳过，
    // 避免把单个超大文件全部读进内存导致 OOM。这是 fallback 路径的硬约束，
    // 用户应通过 ripgrep 或 bash + sed 处理超大文件。
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absPath);
    } catch {
      return;
    }
    if (info.size > NODE_GREP_FILE_SCAN_LIMIT_BYTES) return;

    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return; // 二进制 / 无权限文件跳过
    }
    // 二进制启发式：包含 NUL 字节即视为二进制
    if (content.indexOf("\u0000") !== -1) return;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= GREP_MAX_MATCHES) return;
      const line = lines[i]!;
      if (args.regex.test(line)) {
        matches.push({
          relativePath: relPath,
          lineNumber: i + 1,
          line: truncateLine(line),
        });
      }
    }
  }

  try {
    await walk(args.searchRoot);
  } catch (error) {
    return { kind: "error", reason: describeError(error) };
  }

  if (args.signal.aborted) {
    // 上层 execute 会再做一次 signal 检查；这里也返回空 ok 以保持契约
    return { kind: "ok", matches: [], truncated: false, totalScanned };
  }

  return {
    kind: "ok",
    matches,
    truncated: matches.length >= GREP_MAX_MATCHES,
    totalScanned,
  };
}

// 构造 include glob 匹配器。
//
// 策略：用 `Bun.Glob` 直接匹配相对路径与 basename 两种形式（取并集），
// 兼顾仅 basename 的 `*.ts` 与带目录的递归通配（`src/<双星>/*.ts`）两种常见写法。
function buildIncludeMatcher(
  include: string,
): (relPath: string, basename: string) => boolean {
  const glob = new Bun.Glob(include);
  return (relPath, basename) => glob.match(relPath) || glob.match(basename);
}

// =================== 输出格式 ===================

function formatOutput(result: GrepResult, searchRoot: string): string {
  if (result.kind === "error") {
    // 走到这里意味着 ripgrep + node fallback 都失败 —— 抛错让模型看到
    throw new ToolExecutionError(
      TOOL_NAME,
      `Grep failed in ${sanitizePathForMessage(searchRoot)}: ${result.reason}`,
    );
  }

  const { matches, truncated } = result;
  if (matches.length === 0) return "No matches found.";

  const fileSet = new Set<string>();
  for (const m of matches) fileSet.add(m.relativePath);

  const lines = matches.map(
    (m) => `${m.relativePath}:${m.lineNumber}: ${m.line}`,
  );
  const summary = truncated
    ? `[truncated, showing first ${matches.length} matches across ${fileSet.size} files]`
    : `[${matches.length} match${matches.length === 1 ? "" : "es"} in ${fileSet.size} file${fileSet.size === 1 ? "" : "s"}]`;
  return `${lines.join("\n")}\n${summary}`;
}

// =================== helpers ===================

function readBoolInput(
  input: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = input[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new ToolExecutionError(
      TOOL_NAME,
      `Field '${field}' must be a boolean. Got ${typeof value}.`,
    );
  }
  return value;
}

function readOptionalStringInput(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new ToolExecutionError(
      TOOL_NAME,
      `Field '${field}' must be a non-empty string when provided. Got ${typeof value}.`,
    );
  }
  return value;
}

async function resolveSearchRoot(pathInput: unknown): Promise<string> {
  if (pathInput === undefined || pathInput === null) return process.cwd();
  if (typeof pathInput !== "string" || pathInput === "") {
    throw new ToolExecutionError(
      TOOL_NAME,
      `Field 'path' must be a non-empty string when provided.`,
    );
  }
  const absolute = isAbsolute(pathInput) ? pathInput : resolve(process.cwd(), pathInput);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch (error) {
    throw new ToolExecutionError(
      TOOL_NAME,
      `path does not exist: ${sanitizePathForMessage(absolute)}`,
      { cause: error },
    );
  }
  if (!info.isDirectory()) {
    throw new ToolExecutionError(
      TOOL_NAME,
      `path is not a directory: ${sanitizePathForMessage(absolute)}`,
    );
  }
  return absolute;
}

/** 把绝对路径转为相对 searchRoot 的 posix `/` 分隔路径。 */
function toRelativePosix(absPath: string, searchRoot: string): string {
  const rel = relative(searchRoot, absPath);
  return rel.split(sep).join("/");
}

function truncateLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= GREP_MAX_LINE_BYTES) return line;
  // 简化：按字符截断到 GREP_MAX_LINE_BYTES（utf8 字符可能 1-4 字节，截断后再做长度检查）
  let truncated = line.slice(0, GREP_MAX_LINE_BYTES);
  while (Buffer.byteLength(truncated, "utf8") > GREP_MAX_LINE_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}... [line truncated]`;
}
