/**
 * nova-code 错误体系的聚合入口。
 *
 * 设计：每个错误类一个文件（结构对齐 claude-code 的 src/utils/errors/），
 * 此 index.ts 统一 re-export，方便跨模块一次性 import。
 *
 * LLMApiError 归属 services/api/errors.ts（它是 API 层专有语义，不属于通用错误）。
 */

export { AbortError } from "./AbortError.ts";
export { ConfigError } from "./ConfigError.ts";
export { MaxTurnsExceededError } from "./MaxTurnsExceededError.ts";
export { ToolExecutionError } from "./ToolExecutionError.ts";
