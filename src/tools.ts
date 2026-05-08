/**
 * nova-code 内置工具注册表。
 *
 * 与 claude-code 顶层 src/tools.ts 对齐 —— 注册表在顶层，具体实现在
 * src/tools/<ToolName>/<ToolName>.ts。
 *
 * M1 完整工具集（7 个）：
 * - LS / FileRead / FileWrite / FileEdit / Bash / Grep / Glob
 */

import type { Tool } from "./Tool.ts";
import { BashTool } from "./tools/BashTool/BashTool.ts";
import { FileEditTool } from "./tools/FileEditTool/FileEditTool.ts";
import { FileReadTool } from "./tools/FileReadTool/FileReadTool.ts";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.ts";
import { GlobTool } from "./tools/GlobTool/GlobTool.ts";
import { GrepTool } from "./tools/GrepTool/GrepTool.ts";
import { LSTool } from "./tools/LSTool/LSTool.ts";

/**
 * 内置工具清单。库用户可以选择性使用，也可以传入空数组关闭工具调用。
 * 顺序仅影响 --help 中的展示，不影响功能。
 */
export const builtinTools: readonly Tool[] = [
  LSTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  BashTool,
  GrepTool,
  GlobTool,
];

/**
 * 按名查找工具。Agent loop 收到 tool_use 时用此函数定位执行体。
 *
 * 严格相等查找（`tool.name === name`）。LLM 必须按 schema 返回精确工具名，
 * 模糊匹配反而掩盖 bug。未命中时返回 undefined，由 agent loop 转为
 * is_error=true 的 tool_result 让模型自我纠正（见 src/QueryEngine.ts 的
 * executeOneTool 函数）。
 *
 * 注：M1 仅 7 工具，O(n) 查找完全够用。M8 引入 MCP 工具数膨胀时再换 Map。
 */
export function findTool(name: string, tools: readonly Tool[]): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

// 单工具按命名导出，便于测试与外部按需引用
export { BashTool, FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool, LSTool };
