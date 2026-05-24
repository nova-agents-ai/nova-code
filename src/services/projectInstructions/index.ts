/**
 * services/projectInstructions —— CLAUDE.md 4 层加载 + M12 `.claude/rules` 子系统。
 *
 * 入口：
 *   - getProjectInstructions(cwd, opts) → legacy CLAUDE.md 拼接字符串
 *   - createProjectInstructionsRuntime(cwd, opts) → runtime 规则激活入口
 *
 * 由 AskCommand / ChatCommand 在启动时构造 runtime；QueryEngine 每轮读取最新 instructions。
 */

export type {
  GetProjectInstructionsParams,
  LoadedInstructionFile,
} from "./claudeMd.ts";
export {
  extractIncludePaths,
  formatInstructionFiles,
  getProjectInstructions,
  MAX_INCLUDE_DEPTH,
} from "./claudeMd.ts";
export { findGitRoot, getDirectoryChain } from "./pathDiscovery.ts";
export type {
  ActivateProjectRulesForPathParams,
  ActivateProjectRulesParams,
  CreateProjectInstructionsRuntimeParams,
  ProjectInstructionsRuntime,
  ProjectRuleActivation,
} from "./rules.ts";
export { createProjectInstructionsRuntime } from "./rules.ts";
