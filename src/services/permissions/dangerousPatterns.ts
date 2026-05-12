/**
 * DENY_PATTERNS —— engine 决策流水线第 2 步：Bash 硬黑名单。
 *
 * 与 BashTool 内部 HARD_BANNED_PATTERNS 的关系：
 * - BashTool 的 HARD_BANNED 是"第二道防线"，在 execute() 真正跑命令时再检查一次
 *   （深度防御：即使 PermissionEngine 被绕过，工具自身依然拦截）
 * - 本文件 DENY_PATTERNS 是"第一道防线"，在 engine.evaluate() 就 deny，
 *   连 requestPermission 都不会走（claude-code 也是这个分层）
 *
 * 两份清单互相独立但语义相近；新增危险模式时两处都加，避免用户手动
 * 设 allow 规则能通过 PermissionEngine 但被 BashTool 拒绝的错位。
 *
 * 收录原则：只保留"确定性毁灭操作"。
 * - 不收 `node` / `python` 这类代码执行入口 —— claude-code 因 classifier
 *   做了更细的启发式，nova-code M3 简化，不做
 * - 收 `sudo` / `curl|sh`：plan 明确收入 DENY_PATTERNS（BashTool 侧是 soft warn；
 *   权限层升级为 deny，用户真要用需手动 allow，默认更安全）
 */

// ────────────────────────────────────────────────────────────────────────────
// 内置 DENY 模式
// ────────────────────────────────────────────────────────────────────────────

/**
 * 硬黑名单：仅对 Bash 生效。每一条都是"命中即 deny"。
 *
 * 与 BashTool/HARD_BANNED 的重合项已对齐（见 BashTool.ts §安全过滤）。
 */
export const DENY_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: "rm-rf-root", pattern: /\brm\s+(-[rRfF]+\s+)+\/(\s|$)/ },
  { name: "rm-rf-root-glob", pattern: /\brm\s+(-[rRfF]+\s+)+\/\*/ },
  { name: "rm-rf-home", pattern: /\brm\s+(-[rRfF]+\s+)+~(\/|\s|$)/ },
  { name: "dd-to-disk", pattern: /\bdd\s+.*\bof=\/dev\/(sd|nvme|disk)/ },
  { name: "mkfs", pattern: /\bmkfs\b/ },
  { name: "redirect-to-disk", pattern: />\s*\/dev\/sd[a-z]/ },
  { name: "fork-bomb", pattern: /:\(\)\{\s*:\|:&\s*\};:/ },
  { name: "curl-pipe-shell", pattern: /\b(curl|wget)\s+[^|]*\|\s*(sh|bash|zsh)\b/ },
  { name: "sudo", pattern: /\bsudo\b/ },
];

// ────────────────────────────────────────────────────────────────────────────
// 匹配入口
// ────────────────────────────────────────────────────────────────────────────

/**
 * 检查一条 Bash 命令是否命中 DENY_PATTERNS。
 *
 * 命中返回命中的 pattern.name（用于 engine 日志与错误消息）；未命中返回 null。
 *
 * 非 Bash 工具的调用（FileWrite/FileEdit 等）不应传入本函数 ——
 * DENY_PATTERNS 设计上仅拦截 shell 层的灾难性命令，对 file 写入类工具的
 * 拦截由"deny 规则"与"requiresApproval ask"两条路径负责。
 */
export function checkDenyPatterns(command: string): string | null {
  for (const entry of DENY_PATTERNS) {
    if (entry.pattern.test(command)) return entry.name;
  }
  return null;
}

/**
 * 从 tool 调用 input 里提取 Bash command 字符串。
 *
 * BashTool 的 input schema 是 `{ command: string, ... }`。非字符串 / 缺字段
 * 统一返回 undefined，由 engine 视为"无法判定，走后续规则匹配"——不冒然 deny。
 */
export function extractBashCommand(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)["command"];
  return typeof value === "string" ? value : undefined;
}
