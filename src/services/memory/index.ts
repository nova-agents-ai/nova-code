/**
 * services/memory —— M16 持久化记忆系统（Auto Memory）公共导出。
 *
 * 上层（QueryEngine / AskCommand / ChatCommand / permissionEngine）通过本入口
 * 引入；不要直接 import 子文件，避免内部重排带来的回归。
 *
 * 详见 docs/design/M16-memory.md。
 */

export { memoryAge, memoryAgeDays, memoryFreshnessText } from "./age.ts";
export {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from "./entrypoint.ts";
export type {
  CreateMemoryExtractorFactoryParams,
  RunAgentLoopFn,
} from "./extractor.ts";
export {
  createMemoryExtractorFactory,
  EXTRACTOR_TOOL_WHITELIST,
  hasMemoryWritesSince,
} from "./extractor.ts";
export { parseMemoryDocument } from "./frontmatter.ts";
export type { CreateMemoryRuntimeParams, MemoryRuntime } from "./memoryRuntime.ts";
export {
  createMemoryRuntime,
  ENTRYPOINT_NAME,
  isDisabledRuntime,
  renderRelevantMemoriesAsSystemReminder,
} from "./memoryRuntime.ts";
export {
  ensureMemoryDirExists,
  getAutoMemEntrypoint,
  getAutoMemPath,
  getMemoryBaseDir,
  isAutoMemoryEnabled,
  isAutoMemPath,
} from "./paths.ts";
export type { FindRelevantMemoriesParams } from "./relevance.ts";
export { findRelevantMemories } from "./relevance.ts";
export { formatMemoryManifest, scanMemoryFiles } from "./scan.ts";
export type { MemoryHeader, MemoryType, RelevantMemory, SurfacedMemory } from "./types.ts";
export { MEMORY_TYPES, parseMemoryType } from "./types.ts";
