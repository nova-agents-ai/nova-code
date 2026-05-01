/**
 * 库入口：对外导出 CLI 的可编程接口，方便其他模块或测试直接调用。
 */

// CLI 主流程
export type { RunCliOptions } from "./cli.ts";
export { runCli } from "./cli.ts";

// 命令系统
export type { CommandDefinition, CommandHandler } from "./commands.ts";
export { builtinCommands, findCommand } from "./commands.ts";

// 配置加载
export type { ConfigSource, PersistedConfig, ResolvedConfig } from "./config/config.ts";
export {
  getConfigFilePath,
  loadConfig,
  loadPersistedConfig,
  resolveConfig,
  savePersistedConfig,
} from "./config/config.ts";

// LLM 子系统：Agent loop + 工具系统 + 错误类型
export {
  AbortError,
  ConfigError,
  LLMApiError,
  MaxTurnsExceededError,
  ToolExecutionError,
} from "./llm/errors.ts";
export type { AgentLoopParams } from "./llm/query.ts";
export { runAgentLoop } from "./llm/query.ts";
export { builtinTools, findTool, listDirTool, readFileTool } from "./llm/tools.ts";
export type {
  AgentEvent,
  NovaContentBlock,
  NovaMessage,
  TextBlock,
  Tool,
  ToolExecutionContext,
  ToolInputSchema,
  ToolResultBlock,
  ToolUseBlock,
} from "./llm/types.ts";
export { AgentStopReasonEnum, MessageRoleEnum } from "./llm/types.ts";
