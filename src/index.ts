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

// 错误体系（M1.5 起搬到 src/errors/ 与 src/services/api/errors.ts）
export {
  AbortError,
  ConfigError,
  MaxTurnsExceededError,
  ToolExecutionError,
} from "./errors/index.ts";
export { LLMApiError } from "./services/api/errors.ts";

// Agent loop（M1.5 起搬到 src/QueryEngine.ts）
export type { AgentLoopParams } from "./QueryEngine.ts";
export { runAgentLoop } from "./QueryEngine.ts";

// 工具系统：注册表 + 内置工具（M1 步骤 1 起搬到顶层 src/tools.ts）
export { builtinTools, FileReadTool, findTool, LSTool } from "./tools.ts";

// Tool 接口（M1 步骤 1 起搬到顶层 src/Tool.ts）
export type { Tool, ToolExecutionContext, ToolInputSchema } from "./Tool.ts";

// 消息 / 事件类型（M1.5 起搬到 src/types/message.ts）
export type {
  AgentEvent,
  NovaContentBlock,
  NovaMessage,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./types/message.ts";
export { AgentStopReasonEnum, MessageRoleEnum } from "./types/message.ts";
