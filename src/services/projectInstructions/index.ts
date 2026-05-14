/**
 * services/projectInstructions —— CLAUDE.md 4 层加载子系统。
 *
 * 入口：getProjectInstructions(cwd, opts) → 拼好的字符串（无命中返回 undefined）
 *
 * 由 QueryEngine / ChatCommand / AskCommand 在启动时一次性加载并塞到 system prompt。
 */

export type { GetProjectInstructionsParams } from "./claudeMd.ts";
export { extractIncludePaths, getProjectInstructions, MAX_INCLUDE_DEPTH } from "./claudeMd.ts";
export { findGitRoot, getDirectoryChain } from "./pathDiscovery.ts";
