/**
 * PermissionProvider —— 向用户询问权限决策的抽象接口。
 *
 * 当 evaluatePermission 返回 decision === "ask" 时，QueryEngine 会调用
 * provider.requestPermission() 把决定权交给"某个 UI / headless 策略"：
 *
 * - REPL（ChatCommand）→ SlashIO 实现的 Provider：弹 5 选项菜单给用户选
 * - 单 shot（AskCommand）→ headless Provider：按固定策略（默认 deny，可配置）
 * - 测试 → 简单的 mock（`() => "allow-once"`）
 *
 * 故意把接口放 services/permissions/ 而不是 src/types/：
 * - PermissionProvider 是行为契约（有 Promise 副作用），不是纯数据类型
 * - types/permissions.ts 只装"不带 IO 的领域类型"，保持可静态打包
 *
 * 与 claude-code 对齐的小点：
 * - claude-code 的 bridge 也抽出 "permission callback"（src/bridge/bridgePermissionCallbacks.ts），
 *   形状类似（给个 request → 拿 choice）；我们提前抽口，方便 M3+ REPL / headless 两种实现插拔
 */

import type {
  PermissionDecision,
  PermissionRuleSource,
  UserChoice,
} from "../../types/permissions.ts";

// ────────────────────────────────────────────────────────────────────────────
// 请求结构
// ────────────────────────────────────────────────────────────────────────────

/**
 * 询问时带给 Provider 的信息。
 *
 * reason 来自 evaluatePermission 的 result.reason，用于让 UI 告诉用户
 * "为什么此处要询问"（如 "tool requires approval" / "matched by ... ask rule"）。
 */
export interface PermissionRequest {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

/**
 * 用户对一次 permission_request 的回应。实现方只需返回 UserChoice；
 * QueryEngine 会把它映射回 decision + 可选持久化 source。
 */
export interface PermissionProvider {
  requestPermission(request: PermissionRequest): Promise<UserChoice>;
}

// ────────────────────────────────────────────────────────────────────────────
// UserChoice → Decision 映射
// ────────────────────────────────────────────────────────────────────────────

export interface UserChoiceOutcome {
  /** 最终执行决策（只会是 allow / deny，ask 已在 Provider 那步消化完）。 */
  readonly decision: PermissionDecision;
  /**
   * 需要把本次"具体规则"持久化到哪一层（undefined 表示仅本次放行 / 仅本次拒绝）。
   *
   * QueryEngine 拿到 persistTo 后会构造 PermissionRule（toolName + 从 input 提取的
   * ruleContent + behavior=allow），调 PermissionStore.addRule(persistTo, rule)。
   */
  readonly persistTo?: PermissionRuleSource;
}

/** 把 UserChoice 的 5 档展开为 decision + 可选持久化层。 */
export function decisionFromUserChoice(choice: UserChoice): UserChoiceOutcome {
  switch (choice) {
    case "allow-once":
      return { decision: "allow" };
    case "allow-always-session":
      return { decision: "allow", persistTo: "session" };
    case "allow-always-project":
      return { decision: "allow", persistTo: "project" };
    case "allow-always-global":
      return { decision: "allow", persistTo: "global" };
    case "deny":
      return { decision: "deny" };
  }
}
