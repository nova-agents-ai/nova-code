/**
 * FileEditTool（name: "FileEdit"）—— 字符串替换式编辑现有文件。
 *
 * M1 最关键工具。设计要点（详见 docs/design/M1-tools.md §4.3）：
 *
 * 1. **强制 old_string 唯一**（默认）：N=0 / N>1 都拒绝，模型必须扩大 old_string
 *    上下文使其唯一，或显式 replace_all=true。这是模型可靠编辑的关键约束。
 * 2. **no-op edit 拒绝**：old_string === new_string → 抛错，避免无意义写入。
 * 3. **原子写**：tmp + rename 实现，避免半截文件。tmp 名带 pid + 6位 hex 随机数
 *    避免同进程并发冲突。
 * 4. **fsync 不做**（v2.2 评审 · 性能 Issue #1 明确决定）：agent loop 主线场景
 *    断电不在考虑范围，fsync 写延迟放大不值得。
 * 5. **多 hunk diff 输出**：单次替换显示 1 个 hunk；replace_all 多命中显示前 3 个
 *    hunk，超出用 "... (X more hunks omitted)" 截断。
 * 6. **行数统计口径**：按 "\n" 切分，结尾换行不算单独一行（与 wc -l 一致）。
 *
 * **不支持**：行号编辑、正则替换。两者都让模型容易算错或误伤。
 */

import { randomBytes } from "node:crypto";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { Tool } from "../../Tool.ts";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import {
  describeError,
  EDIT_MAX_FILE_BYTES,
  requireStringField,
  sanitizePathForMessage,
} from "../utils.ts";

const TOOL_NAME = "FileEdit";

/** 单次替换显示 1 hunk；replace_all 命中多次时最多显示前 N hunk。 */
const MAX_HUNKS_SHOWN = 3;

/** Diff hunk 中变更前后各显示的 context 行数。 */
const CONTEXT_LINES = 2;

export const FileEditTool: Tool = {
  name: TOOL_NAME,
  requiresApproval: true,
  description:
    "Edit an existing file by exact string replacement. The old_string must appear " +
    "EXACTLY ONCE in the file (or use replace_all=true to replace every occurrence). " +
    "Use FileWrite to create new files. Empty new_string deletes old_string. " +
    `Maximum file size: ${EDIT_MAX_FILE_BYTES} bytes.`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to an existing file.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to replace. Must appear EXACTLY ONCE in the file (unless replace_all=true).",
      },
      new_string: {
        type: "string",
        description: "Replacement text. Empty string deletes old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "If true, replace every occurrence of old_string. Default false.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: async (input, context) => {
    // ---------- 前置校验（不读文件、不写） ----------
    const path = requireStringField(input, "path", TOOL_NAME);
    // old_string / new_string 允许空字符串：new_string="" 是删除语义
    const oldString = readStringInput(input, "old_string");
    const newString = readStringInput(input, "new_string");
    const replaceAll = readBoolInput(input, "replace_all");

    // b. no-op edit
    if (oldString === newString) {
      throw new ToolExecutionError(
        TOOL_NAME,
        "no-op edit: old_string equals new_string. Nothing to do.",
      );
    }

    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
    const sanitized = sanitizePathForMessage(absolute);

    // c. 文件不存在
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `file not found: ${sanitized}. To create a new file, use FileWrite.`,
        { cause: error },
      );
    }

    if (!info.isFile()) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `path is not a regular file: ${sanitized}.`,
      );
    }

    // d. 文件超大
    if (info.size > EDIT_MAX_FILE_BYTES) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `file too large to edit: ${info.size} bytes (limit ${EDIT_MAX_FILE_BYTES} bytes). ` +
          "Use Bash with sed/awk for very large files.",
      );
    }

    // ---------- 主流程 ----------
    let original: string;
    try {
      original = await readFile(absolute, "utf8");
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Failed to read '${sanitized}': ${describeError(error)}`,
        { cause: error },
      );
    }

    const matchCount = countOccurrences(original, oldString);
    if (matchCount === 0) {
      const lineCount = countLines(original);
      const byteCount = Buffer.byteLength(original, "utf8");
      throw new ToolExecutionError(
        TOOL_NAME,
        `old_string not found in ${sanitized}. The file has ${lineCount} lines and ${byteCount} bytes.`,
      );
    }
    if (matchCount > 1 && !replaceAll) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `old_string found ${matchCount} times in ${sanitized}. Either expand old_string with ` +
          "surrounding context to make it unique, or set replace_all=true.",
      );
    }

    // 计算所有匹配位置（用于 diff 行号 / hunk 提取）
    const matchOffsets = findAllOffsets(original, oldString);
    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);

    // 写入前 abort 检查
    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted before write`);
    }

    await atomicWrite(absolute, updated, sanitized);

    // ---------- 输出摘要 ----------
    const linesBefore = countLines(original);
    const linesAfter = countLines(updated);
    const hunks = buildHunks(original, updated, oldString, newString, matchOffsets);
    const diffSection = formatDiffSection(hunks, matchCount, replaceAll);

    return [
      `Edited ${sanitized}`,
      `- Replacements: ${matchCount}`,
      `- Lines before: ${linesBefore} → after: ${linesAfter}`,
      diffSection,
    ].join("\n");
  },
};

// ---------------- helpers ----------------

/** 读取允许空字符串的字符串字段；非字符串抛错。 */
function readStringInput(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new ToolExecutionError(
      TOOL_NAME,
      `Missing required string field '${field}'. Got ${typeof value}.`,
    );
  }
  return value;
}

/** 读取可选 boolean 字段；缺失或 undefined 视为 false；其他类型抛错。 */
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

/** 计数 needle 在 haystack 中的非重叠出现次数。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0; // 防御：上层 no-op 校验已拦截，但保留兜底
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/** 找出 needle 在 haystack 的所有非重叠起始 offset。 */
function findAllOffsets(haystack: string, needle: string): readonly number[] {
  if (needle === "") return [];
  const offsets: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + needle.length;
  }
  return offsets;
}

/**
 * 行数统计口径：按 "\n" 切分，结尾换行不算单独一行（与 wc -l / 多数编辑器一致）。
 *
 * - "" → 0
 * - "a" → 1
 * - "a\n" → 1
 * - "a\nb" → 2
 * - "a\nb\n" → 2
 * - "\n" → 1（一个空行后的行尾换行）
 */
function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

interface DiffHunk {
  /** Hunk 在变更前文件中的起始行号 (1-indexed)，指向首行 context（若无 context 则指向首行 removed）。 */
  startLine: number;
  /** Context 行（hunk 头部，前 context）。 */
  beforeContext: readonly string[];
  /** 被删除的整行。 */
  removed: readonly string[];
  /** 新增的整行。 */
  added: readonly string[];
  /** Context 行（hunk 尾部，后 context）。 */
  afterContext: readonly string[];
}

/**
 * 为每个匹配位置构造 1 个行级 hunk，并合并"覆盖同一行集合"的相邻匹配。
 *
 * 算法（行级 unified diff，避免实现完整 LCS）：
 *
 * 1. 对每个 match offset，求其"覆盖行"范围 [firstLineIdx, lastLineIdx]（基于 original）
 * 2. 合并：若两个匹配的覆盖行范围相邻或重叠（即 next.first <= prev.last + 1），
 *    合并为一个组。这样 replace_all 多匹配在同一行时只产 1 个 hunk，避免互相矛盾的 diff
 * 3. 对每个合并后的组：
 *    - removedLines = original 中该行块的整行集合
 *    - addedLines = updated 中**对应**的行块（用 originalIndex → updatedIndex 映射；
 *      映射通过：oldString/newString 长度差 + 已替换匹配数计算）
 *    - context 来自 original 前后各 CONTEXT_LINES 行
 *
 * 关键：addedLines 必须基于真正写入的 updated 内容，而不是"假设单个替换"模拟，
 * 否则 replace_all 多匹配同行场景会展示错误的 diff（每个 hunk 互相矛盾）。
 */
function buildHunks(
  original: string,
  updated: string,
  oldString: string,
  newString: string,
  matchOffsets: readonly number[],
): readonly DiffHunk[] {
  if (matchOffsets.length === 0) return [];

  const originalLines = original.split("\n");
  const updatedLines = updated.split("\n");
  // "幽灵空行"处理：
  // 1. 空字符串 "" → split 得 [""]，唯一元素是幽灵 → trueLastIdx = -1（无真实行）
  // 2. 内容以 \n 结尾 → 末尾多出一个空字符串元素，剔除
  // 3. 否则末尾元素是真实的"无尾换行"行
  const trueLastIdxOriginal =
    original === "" ? -1 : original.endsWith("\n") ? originalLines.length - 2 : originalLines.length - 1;
  const trueLastIdxUpdated =
    updated === "" ? -1 : updated.endsWith("\n") ? updatedLines.length - 2 : updatedLines.length - 1;

  // 1. 每个 match 计算覆盖行范围 + 在 updated 中对应的"行偏移"
  interface MatchRange {
    firstLineIdx: number;
    lastLineIdx: number;
  }
  const ranges: MatchRange[] = matchOffsets.map((offset) => {
    const matchEnd = offset + oldString.length;
    const firstLineIdx = countNewlinesBefore(original, offset);
    let lastLineIdx = countNewlinesBefore(original, matchEnd);
    if (matchEnd > offset && original[matchEnd - 1] === "\n") {
      lastLineIdx -= 1;
    }
    if (lastLineIdx < firstLineIdx) lastLineIdx = firstLineIdx;
    if (lastLineIdx > trueLastIdxOriginal && trueLastIdxOriginal >= 0) {
      lastLineIdx = trueLastIdxOriginal;
    }
    return { firstLineIdx, lastLineIdx };
  });

  // 2. 合并相邻 / 重叠 range（matchOffsets 已按文件顺序排列）
  interface MatchGroup {
    firstLineIdx: number;
    lastLineIdx: number;
    /** 该组覆盖了 matchOffsets 中第 [startMatchIdx, endMatchIdx) 个匹配 */
    startMatchIdx: number;
    endMatchIdx: number;
  }
  const groups: MatchGroup[] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]!;
    const last = groups[groups.length - 1];
    if (last && r.firstLineIdx <= last.lastLineIdx + 1) {
      // 相邻或重叠 → 合并到上一组
      if (r.lastLineIdx > last.lastLineIdx) last.lastLineIdx = r.lastLineIdx;
      last.endMatchIdx = i + 1;
    } else {
      groups.push({
        firstLineIdx: r.firstLineIdx,
        lastLineIdx: r.lastLineIdx,
        startMatchIdx: i,
        endMatchIdx: i + 1,
      });
    }
  }

  // 3. 为每个组生成 hunk
  // 计算每个匹配带来的"行数变化" = newString 行数 - oldString 行数（按 \n 计数）
  const oldLineCount = oldString.split("\n").length;
  const newLineCount = newString.split("\n").length;
  const linesDeltaPerMatch = newLineCount - oldLineCount;

  return groups.map((group) => {
    const removedLines = sliceLines(originalLines, group.firstLineIdx, group.lastLineIdx);

    // updated 中对应的"行块"起点 = 原起点 + 之前所有已应用匹配的累计行数变化
    // group.startMatchIdx 之前的所有匹配已经在 updated 中应用过
    const updatedFirstLineIdx =
      group.firstLineIdx + group.startMatchIdx * linesDeltaPerMatch;
    // updated 中对应行块的"行数" = removedLines.length + 本组内匹配数 * linesDelta
    const matchesInGroup = group.endMatchIdx - group.startMatchIdx;
    const updatedLineCount = removedLines.length + matchesInGroup * linesDeltaPerMatch;
    const updatedLastLineIdx = updatedFirstLineIdx + updatedLineCount - 1;
    const addedLines = sliceLines(
      updatedLines,
      updatedFirstLineIdx,
      Math.min(updatedLastLineIdx, trueLastIdxUpdated),
    );

    // context（基于 original）
    const ctxStartIdx = Math.max(0, group.firstLineIdx - CONTEXT_LINES);
    const ctxEndIdx = Math.min(
      trueLastIdxOriginal,
      group.lastLineIdx + CONTEXT_LINES,
    );
    const beforeContext = sliceLines(originalLines, ctxStartIdx, group.firstLineIdx - 1);
    const afterContext = sliceLines(originalLines, group.lastLineIdx + 1, ctxEndIdx);

    return {
      startLine: ctxStartIdx + 1, // 1-indexed
      beforeContext,
      removed: removedLines,
      added: addedLines,
      afterContext,
    };
  });
}

/**
 * 安全切片：返回 lines[from..to]（闭区间，0-indexed）。
 * - from > to 或越界 → 返回空数组
 * - from < 0 截到 0
 */
function sliceLines(
  lines: readonly string[],
  from: number,
  to: number,
): readonly string[] {
  if (from > to) return [];
  if (from < 0) from = 0;
  if (to >= lines.length) to = lines.length - 1;
  if (from > to) return [];
  return lines.slice(from, to + 1);
}

/** 统计 [0, offset) 区间内的 \n 字符数（即 offset 所在的 0-indexed 行号）。 */
function countNewlinesBefore(content: string, offset: number): number {
  let count = 0;
  const upper = Math.min(offset, content.length);
  for (let i = 0; i < upper; i += 1) {
    if (content[i] === "\n") count += 1;
  }
  return count;
}

/** 把 hunk 列表格式化为 diff 段落（unified diff 风格：context 用空格前缀，删除 -，新增 +）。 */
function formatDiffSection(
  hunks: readonly DiffHunk[],
  matchCount: number,
  replaceAll: boolean,
): string {
  if (hunks.length === 0) return "- Diff: (none)";

  const shown = hunks.slice(0, MAX_HUNKS_SHOWN);
  const omitted = hunks.length - shown.length;

  const header =
    replaceAll && matchCount > 1
      ? `- Diff (first ${shown.length} hunk${shown.length === 1 ? "" : "s"}):`
      : "- Diff:";

  const blocks = shown.map((hunk) => {
    const lines: string[] = [`  @@ line ${hunk.startLine} @@`];
    for (const line of hunk.beforeContext) lines.push(`    ${line}`);
    for (const line of hunk.removed) lines.push(`  - ${line}`);
    for (const line of hunk.added) lines.push(`  + ${line}`);
    for (const line of hunk.afterContext) lines.push(`    ${line}`);
    return lines.join("\n");
  });

  const tail = omitted > 0 ? `\n  ... (${omitted} more hunks omitted)` : "";
  return `${header}\n${blocks.join("\n")}${tail}`;
}

/**
 * 原子写：tmp + rename。tmp 名带 pid + 6 位 hex 随机数避免同进程内并发冲突，
 * 同目录写 tmp 保证 rename 是同 mount 原子操作。
 *
 * @param absolute 目标文件绝对路径
 * @param content 要写入的新内容
 * @param sanitized 用于错误消息的脱敏路径
 */
async function atomicWrite(
  absolute: string,
  content: string,
  sanitized: string,
): Promise<void> {
  const random = randomBytes(3).toString("hex"); // 6 hex chars
  const tmpPath = `${absolute}.${process.pid}.${random}.tmp`;

  try {
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new ToolExecutionError(
      TOOL_NAME,
      `Failed to write tmp file for '${sanitized}': ${describeError(error)}`,
      { cause: error },
    );
  }

  try {
    await rename(tmpPath, absolute);
  } catch (error) {
    // rename 失败 → 清理 tmp（清理失败也无所谓，最坏留个孤儿文件）
    await unlink(tmpPath).catch(() => {});
    throw new ToolExecutionError(
      TOOL_NAME,
      `Failed to rename tmp file to '${sanitized}': ${describeError(error)}`,
      { cause: error },
    );
  }
}
