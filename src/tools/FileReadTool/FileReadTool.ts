/**
 * FileReadTool（name: "FileRead"）—— 读取指定文件的内容。
 *
 * 由 M0 阶段的 read_file 工具迁移而来。M1 步骤 1 重命名为 PascalCase（与
 * claude-code 工具命名对齐，见 docs/design/M1-tools.md §3.3）。
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import { describeError, MAX_FILE_BYTES, requireStringField } from "../utils.ts";

const TOOL_NAME = "FileRead";

export const FileReadTool: Tool = {
  name: TOOL_NAME,
  description:
    "Read the contents of a text file. Files larger than " +
    `${MAX_FILE_BYTES} bytes are truncated. Use LS first to discover ` +
    "available files.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute or relative path to the file. Relative paths resolve against the process cwd.",
      },
    },
    required: ["path"],
  },
  execute: async (input, _context) => {
    const path = requireStringField(input, "path", TOOL_NAME);
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Cannot stat '${absolute}': ${describeError(error)}`,
        { cause: error },
      );
    }

    if (!info.isFile()) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Path '${absolute}' exists but is not a regular file.`,
      );
    }

    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Failed to read '${absolute}': ${describeError(error)}`,
        { cause: error },
      );
    }

    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      const truncated = content.slice(0, MAX_FILE_BYTES);
      return `${truncated}\n\n... (truncated at ${MAX_FILE_BYTES} bytes)`;
    }
    return content;
  },
};
