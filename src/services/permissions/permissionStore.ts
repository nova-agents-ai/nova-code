/**
 * PermissionStore —— 三层规则存储与合并。
 *
 * 存储三层：
 * - `session`：当前 REPL 进程内存（lazy 创建），生命周期随 process 退出消失
 * - `project`：`<cwd>/.nova-code/permissions.json`
 * - `global`：`~/.nova-code/permissions.json`
 *
 * 文件 schema（project / global 同形）：
 * ```json
 * {
 *   "version": 1,
 *   "rules": [
 *     { "toolName": "Bash", "ruleContent": "git:*", "behavior": "allow" }
 *   ]
 * }
 * ```
 *
 * 设计原则（对齐 config.ts）：
 * - 文件不存在视为"空规则"（非致命）
 * - JSON 损坏 / 字段校验失败 → 抛 ConfigError（让用户修文件）
 * - 所有 IO 都通过 PermissionStoreSource 的 homeDir 注入，便于单测不碰真实家目录
 * - 不引 zod：手写 validator
 *
 * 与 claude-code 的差异：
 * - claude-code 规则文件放 `.claude/settings.json` 并与其它配置混合；
 *   nova-code 独立 `.nova-code/permissions.json`，结构更单一，失败面小
 * - claude-code 规则去重键用 allow-rules / deny-rules 分集；
 *   本实现用 permissionRuleKey（toolName\truleContent）单键，
 *   后加入的 behavior 覆盖先加入的（语义：最新决策胜出）
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "../../errors/index.ts";
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleWithSource,
} from "../../types/permissions.ts";
import {
  normalizePermissionRule,
  permissionRuleKey,
  validatePermissionRule,
} from "./PermissionRule.ts";

// ────────────────────────────────────────────────────────────────────────────
// 路径常量
// ────────────────────────────────────────────────────────────────────────────

const CONFIG_DIR_NAME = ".nova-code";
const PERMISSIONS_FILE_NAME = "permissions.json";
const CURRENT_VERSION = 1 as const;

/** 持久化文件内容的 schema。 */
export interface PersistedRulesFile {
  readonly version: typeof CURRENT_VERSION;
  readonly rules: readonly PermissionRule[];
}

/** 注入 home 目录（测试用临时路径覆盖真实 ~）。 */
export interface PermissionStoreSource {
  readonly homeDir?: string;
}

/** 计算 project 规则文件的绝对路径。 */
export function getProjectPermissionsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, PERMISSIONS_FILE_NAME);
}

/** 计算 global 规则文件的绝对路径。 */
export function getGlobalPermissionsPath(source: PermissionStoreSource = {}): string {
  const home = source.homeDir ?? homedir();
  return join(home, CONFIG_DIR_NAME, PERMISSIONS_FILE_NAME);
}

// ────────────────────────────────────────────────────────────────────────────
// 纯函数：load / save（project + global 复用）
// ────────────────────────────────────────────────────────────────────────────

/** 从指定路径读规则；文件不存在视为空列表（非错误）。 */
export async function loadRulesFromFile(path: string): Promise<readonly PermissionRule[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw new ConfigError(`Failed to read permissions file at ${path}: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Permissions file at ${path} is not valid JSON: ${describeError(error)}`);
  }

  return validateRulesFile(parsed, path);
}

/** 将规则列表写入文件（自动建目录）。 */
export async function saveRulesToFile(
  path: string,
  rules: readonly PermissionRule[],
): Promise<void> {
  const body: PersistedRulesFile = { version: CURRENT_VERSION, rules };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to write permissions file at ${path}: ${describeError(error)}`);
  }
}

/** 便捷：按 cwd 加载 project 规则。 */
export function loadProjectRules(cwd: string): Promise<readonly PermissionRule[]> {
  return loadRulesFromFile(getProjectPermissionsPath(cwd));
}

/** 便捷：按 cwd 保存 project 规则。 */
export function saveProjectRules(cwd: string, rules: readonly PermissionRule[]): Promise<void> {
  return saveRulesToFile(getProjectPermissionsPath(cwd), rules);
}

/** 便捷：加载 global 规则。 */
export function loadGlobalRules(
  source: PermissionStoreSource = {},
): Promise<readonly PermissionRule[]> {
  return loadRulesFromFile(getGlobalPermissionsPath(source));
}

/** 便捷：保存 global 规则。 */
export function saveGlobalRules(
  rules: readonly PermissionRule[],
  source: PermissionStoreSource = {},
): Promise<void> {
  return saveRulesToFile(getGlobalPermissionsPath(source), rules);
}

// ────────────────────────────────────────────────────────────────────────────
// 规则去重 / 合并
// ────────────────────────────────────────────────────────────────────────────

/**
 * 往规则列表追加一条规则；若 key（toolName+ruleContent）已存在则替换 behavior。
 *
 * 返回新列表（不原地修改原数组）。调用方应保证 rule 已是合法形状（静态类型即担保）。
 */
export function upsertRule(
  rules: readonly PermissionRule[],
  rule: PermissionRule,
): readonly PermissionRule[] {
  const key = permissionRuleKey(rule);
  const result: PermissionRule[] = [];
  let replaced = false;
  for (const existing of rules) {
    if (permissionRuleKey(existing) === key) {
      result.push(rule);
      replaced = true;
    } else {
      result.push(existing);
    }
  }
  if (!replaced) result.push(rule);
  return result;
}

/** 从规则列表移除匹配 key 的规则。返回新列表。 */
export function removeRuleByKey(
  rules: readonly PermissionRule[],
  key: string,
): readonly PermissionRule[] {
  return rules.filter((r) => permissionRuleKey(r) !== key);
}

// ────────────────────────────────────────────────────────────────────────────
// PermissionStore 类：封装三层合并与写回
// ────────────────────────────────────────────────────────────────────────────

/**
 * PermissionStore 负责：
 * 1. 加载 project + global 规则
 * 2. 维护 session 规则（内存）
 * 3. 提供 getMergedRules() 给 PermissionEngine
 * 4. 提供 addRule(source, rule) 做三层的增加 + 自动写盘
 *
 * 状态是 mutable 的（session 规则不断追加），但 getMergedRules 每次返回全新数组，
 * 避免外部拿到引用后被 store 内部的变更"偷偷改掉"。
 */
export class PermissionStore {
  private sessionRules: readonly PermissionRule[];
  private projectRules: readonly PermissionRule[];
  private globalRules: readonly PermissionRule[];

  constructor(params: {
    readonly cwd: string;
    readonly projectRules: readonly PermissionRule[];
    readonly globalRules: readonly PermissionRule[];
    readonly sessionRules?: readonly PermissionRule[];
    readonly source?: PermissionStoreSource;
  }) {
    this.cwd = params.cwd;
    this.source = params.source ?? {};
    this.sessionRules = params.sessionRules ?? [];
    this.projectRules = params.projectRules;
    this.globalRules = params.globalRules;
  }

  readonly cwd: string;
  readonly source: PermissionStoreSource;

  /** 便捷构造：并行读 project + global，session 留空。 */
  static async load(cwd: string, source: PermissionStoreSource = {}): Promise<PermissionStore> {
    const [projectRules, globalRules] = await Promise.all([
      loadProjectRules(cwd),
      loadGlobalRules(source),
    ]);
    return new PermissionStore({ cwd, projectRules, globalRules, source });
  }

  /** 合并后的带 source 规则列表（session > project > global，保留输入顺序）。 */
  getMergedRules(): readonly PermissionRuleWithSource[] {
    const result: PermissionRuleWithSource[] = [];
    for (const rule of this.sessionRules) result.push({ source: "session", rule });
    for (const rule of this.projectRules) result.push({ source: "project", rule });
    for (const rule of this.globalRules) result.push({ source: "global", rule });
    return result;
  }

  /** 只读获取某一层的规则快照。 */
  listBySource(source: PermissionRuleSource): readonly PermissionRule[] {
    if (source === "session") return this.sessionRules;
    if (source === "project") return this.projectRules;
    return this.globalRules;
  }

  /**
   * 增加一条规则到指定 source，自动去重 + 持久化（project/global）。
   *
   * - session：只改内存
   * - project：改内存并写 `<cwd>/.nova-code/permissions.json`
   * - global：改内存并写 `~/.nova-code/permissions.json`
   */
  async addRule(source: PermissionRuleSource, rule: PermissionRule): Promise<void> {
    const normalized = normalizeOrThrow(rule, "<addRule input>");
    if (source === "session") {
      this.sessionRules = upsertRule(this.sessionRules, normalized);
      return;
    }
    if (source === "project") {
      this.projectRules = upsertRule(this.projectRules, normalized);
      await saveProjectRules(this.cwd, this.projectRules);
      return;
    }
    this.globalRules = upsertRule(this.globalRules, normalized);
    await saveGlobalRules(this.globalRules, this.source);
  }

  /** 按 key 从指定 source 删除规则；project/global 会立即写盘。 */
  async removeRule(source: PermissionRuleSource, key: string): Promise<boolean> {
    const before = this.listBySource(source);
    const after = removeRuleByKey(before, key);
    if (after.length === before.length) return false;
    if (source === "session") {
      this.sessionRules = after;
      return true;
    }
    if (source === "project") {
      this.projectRules = after;
      await saveProjectRules(this.cwd, this.projectRules);
      return true;
    }
    this.globalRules = after;
    await saveGlobalRules(this.globalRules, this.source);
    return true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 内部：JSON 校验 / 错误工具
// ────────────────────────────────────────────────────────────────────────────

function validateRulesFile(value: unknown, path: string): readonly PermissionRule[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `Permissions file at ${path} must be a JSON object, got ${typeName(value)}.`,
    );
  }
  const obj = value as Record<string, unknown>;
  if (obj["version"] !== CURRENT_VERSION) {
    throw new ConfigError(
      `Permissions file at ${path}: unsupported version ${String(obj["version"])}, expected ${CURRENT_VERSION}.`,
    );
  }
  if (!Array.isArray(obj["rules"])) {
    throw new ConfigError(
      `Permissions file at ${path}: 'rules' must be an array, got ${typeName(obj["rules"])}.`,
    );
  }
  const result: PermissionRule[] = [];
  for (let i = 0; i < obj["rules"].length; i += 1) {
    try {
      result.push(normalizeOrThrow(obj["rules"][i], `${path} rule #${i}`));
    } catch (error) {
      throw new ConfigError(
        `Permissions file at ${path}: rule #${i} invalid: ${describeError(error)}`,
      );
    }
  }
  return result;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 校验 + 规范化输入，失败抛 ConfigError。
 *
 * context 用于错误消息溯源（如 文件路径 + 规则 index），便于用户排查
 * 哪一条规则出问题。返回成功规范化的 PermissionRule，静态类型保证非 undefined。
 */
function normalizeOrThrow(value: unknown, context: string): PermissionRule {
  const error = validatePermissionRule(value);
  if (error !== undefined) {
    throw new ConfigError(`${context}: ${error}`);
  }
  const rule = normalizePermissionRule(value);
  if (rule === undefined) {
    // 理论上不可达（validate 通过 → normalize 不会返 undefined）
    throw new ConfigError(`${context}: 规范化失败 (internal bug)`);
  }
  return rule;
}
