/**
 * 权限系统的核心领域类型。
 *
 * M3 新增，对齐 claude-code/src/utils/permissions/PermissionMode.ts 与
 * PermissionRule.ts 的核心形状，但取精华去复杂：
 * - 4 档 Mode（去掉 claude-code 的 dontAsk 与内部 auto）
 * - Rule = { toolName, ruleContent?, behavior } 三元组（完全对齐）
 * - 三层 Source（session / project / global）
 *
 * 放 src/types/ 的原因：Tool / QueryEngine / ChatCommand 都要引用，
 * 下沉到 services/permissions/ 会引入"types 反向依赖 services"的不自然依赖。
 * 与 types/message.ts 保持同层，作为跨模块共享的领域类型。
 *
 * 设计取舍（详见 docs/design/M3-permissions.md §二）：
 * - 所有字段 readonly：规则列表按"不可变数组追加替换"而非原地变更的语义使用
 * - 用 string literal union 而非 enum：和 claude-code 一致，便于 JSON 直接序列化
 * - UserChoice 单列 type：规则升级路径（once/session/project/global/deny）
 *   是 REPL 面向用户的选项集合，与 engine 内部使用的 Behavior 不同
 */

// ────────────────────────────────────────────────────────────────────────────
// Mode
// ────────────────────────────────────────────────────────────────────────────

/**
 * 权限模式。影响 engine 决策流水线第 1、5 步。
 *
 * - `default`：所有 requiresApproval=true 的工具都走 ask
 * - `acceptEdits`：FileEdit/FileWrite 自动允许（ask 路径默认此模式），Bash 仍走 ask
 * - `bypassPermissions`：全部放行（`--dangerously-skip-permissions` 触发），但仍过 DENY_PATTERNS
 * - `plan`：计划获批前禁止 Bash/FileWrite/FileEdit，只允许读代码和产出计划
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

// ────────────────────────────────────────────────────────────────────────────
// Rule
// ────────────────────────────────────────────────────────────────────────────

/** 规则行为。与 claude-code 的 PermissionBehavior 字段完全对齐。 */
export type PermissionBehavior = "allow" | "deny" | "ask";

/**
 * 一条权限规则。
 *
 * - `toolName`：工具名（Bash / FileWrite / FileEdit / ...）。
 *   不校验枚举，留口给未来 MCP 工具（名字可能任意）。
 * - `ruleContent`：工具内子规则。空值表示"无差别匹配该工具的所有调用"。
 *   - Bash："git" 或 "git status:*"（命令名 或 "命令名:子命令前缀"）
 *   - FileWrite / FileEdit：glob（"docs/**\/*"）
 * - `behavior`：allow / deny / ask。
 *
 * 形状与 claude-code/src/utils/permissions/PermissionRule.ts 的
 * PermissionRuleValue + PermissionBehavior 对齐；仅扁平化为单对象。
 */
export interface PermissionRule {
  readonly toolName: string;
  readonly ruleContent?: string;
  readonly behavior: PermissionBehavior;
}

// ────────────────────────────────────────────────────────────────────────────
// Source（三层持久化）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 规则来源。影响合并后 allow 规则的优先级：session > project > global。
 *
 * - `session`：当前 REPL 进程内存（`/permissions add` 或 allow-always-session 产生）
 * - `project`：`<cwd>/.nova-code/permissions.json`
 * - `global`：`~/.nova-code/permissions.json`
 *
 * deny 规则不按 source 排序 —— 任何一层的 deny 都是最高优先级（安全从严）。
 */
export type PermissionRuleSource = "session" | "project" | "global";

/** 带 source 标签的规则。engine 和 store 合并规则列表时使用。 */
export interface PermissionRuleWithSource {
  readonly rule: PermissionRule;
  readonly source: PermissionRuleSource;
}

// ────────────────────────────────────────────────────────────────────────────
// Decision
// ────────────────────────────────────────────────────────────────────────────

/**
 * engine.evaluate() 返回给 QueryEngine 的决策。
 *
 * - `allow`：放行，直接 execute
 * - `deny`：拒绝，抛 ToolExecutionError
 * - `ask`：询问用户（QueryEngine 走 PermissionProvider.requestPermission）
 */
export type PermissionDecision = "allow" | "deny" | "ask";

// ────────────────────────────────────────────────────────────────────────────
// UserChoice（REPL 询问返回值）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 用户面对 permission_request 时的 5 档选择。
 *
 * - `allow-once`：本次放行，不持久化
 * - `allow-always-session`：升级为 session 规则（本进程内后续同形匹配自动放行）
 * - `allow-always-project`：升级为 project 规则（写 `.nova-code/permissions.json`）
 * - `allow-always-global`：升级为 global 规则（写 `~/.nova-code/permissions.json`）
 * - `deny`：本次拒绝
 *
 * 不做 `deny-always`：否定规则不走用户交互升级，用户若要持久 deny 应显式用
 * `/permissions add <tool> [content] deny` 书面声明，避免"手滑升级 deny"之后
 * 找不回来的体验问题。
 */
export type UserChoice =
  | "allow-once"
  | "allow-always-session"
  | "allow-always-project"
  | "allow-always-global"
  | "deny";
