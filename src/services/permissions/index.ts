/**
 * 权限系统对外公开 API 的聚合入口。
 *
 * 设计动机：
 * - 调用方（QueryEngine / ChatCommand / AskCommand）只依赖这个入口，
 *   不直接 reach into 内部文件，方便后续内部拆分重组
 * - 类型从 src/types/permissions.ts re-export，与 services/api/ 的风格一致
 *
 * M3 当前公开：
 * - 类型：PermissionMode / PermissionBehavior / PermissionRule / PermissionDecision / UserChoice
 * - 常量 / 校验：PERMISSION_MODES / parsePermissionMode / PERMISSION_BEHAVIORS / validatePermissionRule
 * - 匹配器 / 引擎 / 存储 / DENY_PATTERNS 在后续 Task 中扩展本文件
 */

export type {
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleWithSource,
  UserChoice,
} from "../../types/permissions.ts";

export { isPermissionMode, PERMISSION_MODES, parsePermissionMode } from "./PermissionMode.ts";
export type {
  PermissionProvider,
  PermissionRequest,
  UserChoiceOutcome,
} from "./PermissionProvider.ts";
export { decisionFromUserChoice } from "./PermissionProvider.ts";
export {
  isPermissionBehavior,
  normalizePermissionRule,
  PERMISSION_BEHAVIORS,
  permissionRuleKey,
  validatePermissionRule,
} from "./PermissionRule.ts";
export type {
  PermissionEvaluationInput,
  PermissionEvaluationResult,
} from "./permissionEngine.ts";
export { evaluatePermission } from "./permissionEngine.ts";
export type { PermissionStoreSource, PersistedRulesFile } from "./permissionStore.ts";
export {
  getGlobalPermissionsPath,
  getProjectPermissionsPath,
  loadGlobalRules,
  loadProjectRules,
  loadRulesFromFile,
  PermissionStore,
  removeRuleByKey,
  saveGlobalRules,
  saveProjectRules,
  saveRulesToFile,
  upsertRule,
} from "./permissionStore.ts";
