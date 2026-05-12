/**
 * PermissionEngine —— 纯函数版七步决策流水线。
 *
 * 这是 M3 权限系统的"大脑"。所有调用方（QueryEngine / 测试 / 未来 headless 工具）
 * 都应通过本文件暴露的 evaluatePermission 获得一致的决策语义。
 *
 * ─── 七步流水线（严格顺序，第一个命中即返回）────────────────────────────
 *
 * 1. DENY_PATTERNS（仅 Bash）
 *    Bash 命令命中内置灾难模式（rm -rf /、dd to disk、mkfs、sudo、curl|sh …）
 *    → deny。**连 bypassPermissions 也不能绕过此步**（深度防御）。
 *
 * 2. bypassPermissions mode
 *    `--dangerously-skip-permissions` 开启时，除 DENY_PATTERNS 外全部 allow。
 *
 * 3. deny 规则（三层汇总，不按 source 优先级）
 *    任何 source 里出现 deny 都是最高优先级；命中即 deny。
 *    安全从严：用户在任何一层明确 deny 都应立即生效。
 *
 * 4. allow / ask 规则（session > project > global，同 source 先到先胜）
 *    在同一 source 内按规则列表顺序遍历，第一个 behavior 非 deny 的命中就返回。
 *    - behavior === "allow" → allow
 *    - behavior === "ask"   → ask（即使工具 requiresApproval=false 也强制询问）
 *
 * 5. acceptEdits mode
 *    模式为 acceptEdits 且工具是 FileWrite/FileEdit → allow。
 *    这是 Ask headless 默认模式：文件编辑自动放行，Bash/其它仍走后续步。
 *
 * 6. requiresApproval=true
 *    工具声明需要审批 → ask。
 *
 * 7. 默认（requiresApproval=false / 未设置）
 *    只读工具自动 allow。
 *
 * ─── 与 claude-code 的差异 ────────────────────────────────────────────
 *
 * - claude-code 多步合并多种 source 的 allow 规则；本引擎为了"source 严格分层"
 *   显式三层嵌套遍历，实现比 claude-code 更清晰
 * - claude-code deny 规则按 source 也有优先级；本引擎**任何 source 的 deny 都立即生效**，
 *   这在 plan §二被明确为"安全从严"的选型
 * - claude-code 没有 ask 规则能覆盖 requiresApproval=false；本引擎支持，
 *   让用户可以为只读工具也加强制审批
 */

import type {
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleWithSource,
} from "../../types/permissions.ts";
import { BASH_TOOL_NAME, matchBashRule } from "./bashRuleMatcher.ts";
import { checkDenyPatterns, extractBashCommand } from "./dangerousPatterns.ts";
import { extractFilePath, isFileWriteToolName, matchFileRule } from "./fileRuleMatcher.ts";

// ────────────────────────────────────────────────────────────────────────────
// 输入 / 输出
// ────────────────────────────────────────────────────────────────────────────

/**
 * evaluatePermission 的输入。所有字段由调用方（QueryEngine）准备，
 * engine 自身不读任何全局状态，便于单元测试。
 */
export interface PermissionEvaluationInput {
  /** 当前 session 的权限模式。 */
  readonly mode: PermissionMode;
  /** 工具名（与 Tool.name 一致）。 */
  readonly toolName: string;
  /**
   * 工具是否声明 requiresApproval=true。
   * engine 不直接读 Tool 对象，由调用方从 Tool.requiresApproval 中取出传入，
   * 保持纯函数属性。
   */
  readonly requiresApproval: boolean;
  /** 工具入参（原始 input，由 engine 自行提取 command / path）。 */
  readonly input: unknown;
  /** 三层合并后的规则列表（session + project + global，顺序无关）。 */
  readonly rules: readonly PermissionRuleWithSource[];
  /** 用于 file glob 相对化；通常是 process.cwd()。 */
  readonly cwd: string;
}

/**
 * evaluatePermission 的返回。reason 是给 log / UI 的人类可读说明。
 * matchedRule / denyPatternName 是可选元信息，方便 UI 展示"被哪条规则命中"。
 */
export interface PermissionEvaluationResult {
  readonly decision: PermissionDecision;
  readonly reason: string;
  readonly matchedRule?: PermissionRuleWithSource;
  readonly denyPatternName?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 对外入口
// ────────────────────────────────────────────────────────────────────────────

/**
 * 评估一次 tool 调用的权限决策。纯函数，无副作用。
 */
export function evaluatePermission(input: PermissionEvaluationInput): PermissionEvaluationResult {
  const { mode, toolName, requiresApproval, input: toolInput, rules, cwd } = input;

  // ── Step 1: DENY_PATTERNS（Bash 独享；bypass 不绕过）
  if (toolName === BASH_TOOL_NAME) {
    const command = extractBashCommand(toolInput);
    if (command !== undefined) {
      const hit = checkDenyPatterns(command);
      if (hit !== null) {
        return {
          decision: "deny",
          reason: `blocked by built-in DENY pattern: ${hit}`,
          denyPatternName: hit,
        };
      }
    }
  }

  // ── Step 2: bypassPermissions
  if (mode === "bypassPermissions") {
    return { decision: "allow", reason: "bypassPermissions mode" };
  }

  // ── Step 3: deny 规则（三层不分优先级）
  for (const entry of rules) {
    if (entry.rule.behavior !== "deny") continue;
    if (!matchRule(entry.rule, toolName, toolInput, cwd)) continue;
    return {
      decision: "deny",
      reason: `blocked by ${entry.source} deny rule`,
      matchedRule: entry,
    };
  }

  // ── Step 4: allow / ask 规则（session > project > global）
  const SOURCE_ORDER: readonly PermissionRuleSource[] = ["session", "project", "global"];
  for (const source of SOURCE_ORDER) {
    for (const entry of rules) {
      if (entry.source !== source) continue;
      if (entry.rule.behavior === "deny") continue; // 已在 Step 3 处理
      if (!matchRule(entry.rule, toolName, toolInput, cwd)) continue;
      return {
        decision: entry.rule.behavior, // "allow" | "ask"
        reason: `matched by ${source} ${entry.rule.behavior} rule`,
        matchedRule: entry,
      };
    }
  }

  // ── Step 5: acceptEdits mode
  if (mode === "acceptEdits" && isFileWriteToolName(toolName)) {
    return { decision: "allow", reason: "acceptEdits mode: file edits auto-approved" };
  }

  // ── Step 6: requiresApproval
  if (requiresApproval) {
    return { decision: "ask", reason: "tool requires approval" };
  }

  // ── Step 7: 默认
  return { decision: "allow", reason: "tool does not require approval (read-only)" };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部：规则匹配分派
// ────────────────────────────────────────────────────────────────────────────

/**
 * 根据 toolName 分派到对应的匹配器。
 *
 * - Bash → matchBashRule + extractBashCommand
 * - FileWrite/FileEdit → matchFileRule + extractFilePath
 * - 其它（只读工具等）→ 只在 ruleContent 为空时算匹配（允许用户整体 allow/deny 某工具）
 *
 * 前置条件：rule.toolName === toolName。本函数不校验 toolName，由外层循环过滤。
 */
function matchRule(rule: PermissionRule, toolName: string, input: unknown, cwd: string): boolean {
  if (rule.toolName !== toolName) return false;

  if (toolName === BASH_TOOL_NAME) {
    const command = extractBashCommand(input);
    if (command === undefined) return false;
    return matchBashRule(rule, command);
  }

  if (isFileWriteToolName(toolName)) {
    const filePath = extractFilePath(input);
    if (filePath === undefined) return false;
    return matchFileRule(rule, filePath, cwd);
  }

  // 其它工具：ruleContent 空 → 匹配整个工具；非空 → 不匹配（语义无定义时从严）
  return rule.ruleContent === undefined || rule.ruleContent === "";
}
