/**
 * LSTool（name: "LS"）—— 列出指定目录下的条目。
 *
 * 由 M0 阶段的 list_dir 工具迁移而来。M1 步骤 1 重命名为 PascalCase（与
 * claude-code 工具命名对齐，见 docs/design/M1-tools.md §3.3）。
 *
 * 注意：claude-code 没有 LSTool（它的目录探索通过 GlobTool 完成），nova-code
 * 保留此工具属于 roadmap §7.0 允许的"小幅偏离 #1"。
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import { describeError, MAX_DIR_ENTRIES, requireStringField } from "../utils.ts";

const TOOL_NAME = "LS";

export const LSTool: Tool = {
  name: TOOL_NAME,
  description:
    "List entries (files and subdirectories) in a directory. Returns up to " +
    `${MAX_DIR_ENTRIES} entries. Use this to explore project structure.`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute or relative path to the directory. Relative paths resolve against the process cwd.",
      },
    },
    required: ["path"],
  },
  execute: async (input, _context) => {
    const path = requireStringField(input, "path", TOOL_NAME);
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

    let entries: string[];
    try {
      entries = await readdir(absolute);
    } catch (error) {
      throw new ToolExecutionError(
        TOOL_NAME,
        `Failed to list directory '${absolute}': ${describeError(error)}`,
        { cause: error },
      );
    }

    const truncated = entries.length > MAX_DIR_ENTRIES;
    const visible = truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries;

    // 给每一项标注是文件还是目录，模型据此决定下一步钻取还是读取
    const annotated = await Promise.all(
      visible.map(async (entry) => {
        const entryPath = resolve(absolute, entry);
        try {
          const info = await stat(entryPath);
          return info.isDirectory() ? `${entry}/` : entry;
        } catch {
          // 软失败：列目录拿到了名字但 stat 失败（权限、symlink 断裂等），
          // 不影响整体结果，标记为未知类型即可
          return `${entry} (?)`;
        }
      }),
    );

    const lines = [`Directory: ${absolute}`, ...annotated];
    if (truncated) {
      lines.push(`... (truncated, showing first ${MAX_DIR_ENTRIES} of ${entries.length} entries)`);
    }
    return lines.join("\n");
  },
};
