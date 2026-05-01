/**
 * nova-code 内置工具集。
 *
 * 设计原则：
 * - 只放安全的、纯只读的工具（list_dir / read_file）。
 *   不放 write_file / exec_shell —— 这类工具需要权限审批系统才能安全使用，
 *   而 nova-code 还没有审批 UI。先做最小可用的，避免误触。
 * - 每个工具的 input_schema 用 as const + satisfies 同时保留字面量类型推断
 *   和 Tool 接口约束。
 * - execute 抛错时由 agent loop 包成 ToolExecutionError 并以 is_error=true
 *   反馈给模型，让模型自我纠正。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ToolExecutionError } from "./errors.ts";
import type { Tool, ToolExecutionContext } from "./types.ts";

/** 单文件读取上限：1 MB。超过则截断并提示，避免把大文件灌进 context。 */
const MAX_FILE_BYTES = 1024 * 1024;

/** 目录列表上限：500 项。避免列出 node_modules 这种大目录把上下文撑爆。 */
const MAX_DIR_ENTRIES = 500;

/**
 * list_dir 工具：列出指定目录下的条目。
 */
const listDirTool: Tool = {
  name: "list_dir",
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
    const path = requireStringField(input, "path", "list_dir");
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

    let entries: string[];
    try {
      entries = await readdir(absolute);
    } catch (error) {
      throw new ToolExecutionError(
        "list_dir",
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

/**
 * read_file 工具：读取指定文件的内容。
 */
const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a text file. Files larger than " +
    `${MAX_FILE_BYTES} bytes are truncated. Use list_dir first to discover ` +
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
    const path = requireStringField(input, "path", "read_file");
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch (error) {
      throw new ToolExecutionError(
        "read_file",
        `Cannot stat '${absolute}': ${describeError(error)}`,
        { cause: error },
      );
    }

    if (!info.isFile()) {
      throw new ToolExecutionError(
        "read_file",
        `Path '${absolute}' exists but is not a regular file.`,
      );
    }

    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch (error) {
      throw new ToolExecutionError(
        "read_file",
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

/**
 * 内置工具清单。库用户可以选择性使用，也可以传入空数组关闭工具调用。
 * 顺序仅影响 --help 中的展示，不影响功能。
 */
export const builtinTools: readonly Tool[] = [listDirTool, readFileTool];

/**
 * 按名查找工具。Agent loop 收到 tool_use 时用此函数定位执行体。
 */
export function findTool(name: string, tools: readonly Tool[]): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

// 测试方便：把单个工具也按命名导出
export { listDirTool, readFileTool };

/** 暴露常量，测试可以验证截断行为。 */
export const TOOL_LIMITS = {
  maxFileBytes: MAX_FILE_BYTES,
  maxDirEntries: MAX_DIR_ENTRIES,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

/**
 * 从工具入参中提取必填字符串字段，缺失或类型错误时抛 ToolExecutionError。
 * 把模型给的"不规范"参数转成清晰的错误信息，让模型自我纠正。
 */
function requireStringField(
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeType(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// 让未使用的 ToolExecutionContext import 类型校验通过：
// 工具签名都接收 context 参数，即便当前未使用，留着便于后续扩展。
export type { ToolExecutionContext };
