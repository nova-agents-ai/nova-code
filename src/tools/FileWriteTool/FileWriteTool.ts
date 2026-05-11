/**
 * FileWriteTool（name: "FileWrite"）—— 创建新文件。
 *
 * 设计要点（详见 docs/design/M1-tools.md §4.2）：
 *
 * 1. **只创建，不覆盖**：写入用 `flag: "wx"`，文件已存在 → 抛错并提示改用 FileEdit。
 *    与 claude-code FileWriteTool 一致，避免模型用 write 误覆盖。
 * 2. **父目录自动 mkdir -p**：节省模型一轮调用。
 * 3. **content 大小上限**：> WRITE_MAX_FILE_BYTES (5MB) → 抛错，建议拆多个文件。
 * 4. **abort 检查**：写入前检查 signal.aborted；写入中不做中断（写一个文件极快，
 *    中断窗口几乎无收益，且会引入半写状态的清理复杂度）。
 *
 * M1 范围内**不做**路径越界检查（`..` 跨出 cwd）。这属于 M3 权限系统统一职责，
 * README 已显式声明此风险。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import {
  describeError,
  requireStringField,
  sanitizePathForMessage,
  WRITE_MAX_FILE_BYTES,
} from "../utils.ts";

const TOOL_NAME = "FileWrite";

/** 计算字符串行数。空文件视为 0 行；末尾无换行的"半行"也算 1 行。 */
function countLines(content: string): number {
  if (content === "") return 0;
  // 用 split 的副作用：'a\nb' → ['a','b'] (2)；'a\n' → ['a',''] (2，末尾换行算分隔)；'a' → ['a'] (1)
  // claude-code FileWriteTool 的口径就是 split('\n').length，与此一致。
  return content.split("\n").length;
}

export const FileWriteTool: Tool = {
  name: TOOL_NAME,
  requiresApproval: true,
  description:
    "Create a new file with the given content. Fails if the file already exists — " +
    "use FileEdit to modify existing files. Parent directories are created automatically. " +
    `Maximum content size: ${WRITE_MAX_FILE_BYTES} bytes.`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path for the new file. The file must NOT already exist.",
      },
      content: {
        type: "string",
        description: "Full file content to write (UTF-8 encoded).",
      },
    },
    required: ["path", "content"],
  },
  execute: async (input, context) => {
    const path = requireStringField(input, "path", TOOL_NAME);
    // content 允许空字符串（创建空文件是合法用例），不能用 requireStringField
    const content = input["content"];
    if (typeof content !== "string") {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Missing required string field 'content'. Got ${typeof content}.`,
      );
    }

    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
    const sanitized = sanitizePathForMessage(absolute);

    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > WRITE_MAX_FILE_BYTES) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Content too large: ${byteLength} bytes exceeds limit of ${WRITE_MAX_FILE_BYTES} bytes. ` +
          "Split into multiple files or use a Bash heredoc for very large content.",
      );
    }

    // abort 前检查（写入开始后不再中断）
    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted before write`);
    }

    // 父目录自动创建（mkdir -p）。recursive: true 时目标已存在不报错。
    const parent = dirname(absolute);
    try {
      await mkdir(parent, { recursive: true });
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Failed to create parent directory '${sanitizePathForMessage(parent)}': ${describeError(error)}`,
        { cause: error },
      );
    }

    // 写入：flag "wx" 保证文件不存在才创建，已存在则抛 EEXIST
    try {
      await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isNodeErrnoException(error) && error.code === "EEXIST") {
        throw new ToolExecutionError(
          TOOL_NAME,
          `File already exists: ${sanitized}. Use FileEdit to modify existing files.`,
          { cause: error },
        );
      }
      throw new ToolExecutionError(
        TOOL_NAME,
        `Failed to write '${sanitized}': ${describeError(error)}`,
        { cause: error },
      );
    }

    const lines = countLines(content);
    return `Created ${sanitized} (${byteLength} bytes, ${lines} lines)`;
  },
};

/** 判断 unknown error 是否为带 code 字段的 Node fs 错误。 */
function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
