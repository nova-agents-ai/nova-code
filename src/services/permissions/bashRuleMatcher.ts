/**
 * Bash 规则匹配器 —— 判断一条 PermissionRule 是否与给定 Bash 命令匹配。
 *
 * 对齐 claude-code/src/utils/permissions/permissions.ts 中 Bash 部分的"命令名 +
 * 子命令"两级前缀语义，但做了大幅简化：
 * - 不做完整 shlex（引号 / 转义 / 变量展开 / 管道拆解）
 * - 只看第一段 pipeline 的首个 token 和次个 token（够用 95% 场景）
 *
 * 支持的 ruleContent 形态（plan §二）：
 *
 * | ruleContent                | 匹配语义                                             |
 * |----------------------------|------------------------------------------------------|
 * | undefined / ""             | 匹配所有 Bash 调用                                   |
 * | "git"                      | 命令恰好是 `git`（无参数）                           |
 * | "git:*"                    | 命令首 token 是 `git`（不管后续参数）                |
 * | "git status"               | 命令恰好是 `git status`（无其它参数）                |
 * | "git status:*"             | 命令首两 token 是 `git status`（后续参数不限）       |
 *
 * 不支持：三级及以上（`git remote add:*`）——首两 token 已覆盖绝大多数场景，
 * 复杂子命令组合建议用 allow-once 逐次确认。
 *
 * 与 fileRuleMatcher 的分工：Bash 工具一律走本匹配器；FileWrite/FileEdit
 * 走 fileRuleMatcher（glob）；其它工具（只读类）应在 engine 层就被
 * "requiresApproval=false → allow"短路，不到本匹配器。
 */

import type { PermissionRule } from "../../types/permissions.ts";

/** Bash 匹配的特殊工具名 —— 与 BashTool.name 严格一致。 */
export const BASH_TOOL_NAME = "Bash";

/**
 * 判断一条 rule 是否适用于给定的 Bash command。
 *
 * 前置条件：rule.toolName === "Bash"。本函数不重复校验 toolName，
 * 由 engine 在遍历规则时过滤（减少重复分支）。
 *
 * 命中返回 true；未命中或 rule 形态非法（如 ruleContent 是乱码）返回 false
 * —— 非法形态视为"不匹配"而不是"拒绝"，保证规则容错：一条坏规则不阻塞整个 session。
 */
export function matchBashRule(rule: PermissionRule, command: string): boolean {
  const content = rule.ruleContent;

  // 1. 无 ruleContent：匹配所有 Bash 调用
  if (content === undefined || content === "") return true;

  // 2. 解析 ruleContent：末尾 `:*` 表示前缀匹配，否则精确匹配
  const isPrefix = content.endsWith(":*");
  const pattern = isPrefix ? content.slice(0, -2) : content;
  // 退化：`":*"` 或 `":* "` 等边界，pattern 为空直接放弃匹配
  if (pattern === "") return false;

  // 3. 拆 pattern 与 command 的 token
  const patternTokens = splitShellTokens(pattern);
  if (patternTokens.length === 0) return false;
  const commandTokens = extractFirstPipelineTokens(command);
  if (commandTokens.length < patternTokens.length) return false;

  // 4. 前 N 个 token 必须逐一相等
  for (let i = 0; i < patternTokens.length; i += 1) {
    if (commandTokens[i] !== patternTokens[i]) return false;
  }

  // 5. 精确匹配：command 的 token 数必须恰好等于 pattern；前缀匹配：允许更长
  if (!isPrefix && commandTokens.length !== patternTokens.length) return false;

  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

/**
 * 提取命令"第一段 pipeline"的 token 列表。
 *
 * 简化解析：
 * 1. 只看 `|` / `&&` / `;` 之前的第一段（后续段用户若需要也应显式 allow）
 * 2. 按空白拆 token；不处理引号 / 转义 / 变量
 *
 * 这个简化在 plan §十二已登记为已知风险；完整 shlex 推迟到 M3.5。
 */
function extractFirstPipelineTokens(command: string): readonly string[] {
  // 截断到第一个 pipeline 分隔符
  const match = /^[^|&;]*/.exec(command.trimStart());
  const firstSegment = match === null ? command : match[0];
  return splitShellTokens(firstSegment);
}

/** 按空白拆 token（忽略空串）。不做引号处理 —— 足够覆盖 `git status -v` 场景。 */
function splitShellTokens(text: string): readonly string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
}
