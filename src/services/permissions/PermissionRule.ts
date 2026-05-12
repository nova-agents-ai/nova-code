/**
 * PermissionRule 运行时校验 / 构造辅助。
 *
 * 对齐 claude-code/src/utils/permissions/PermissionRule.ts 的校验语义，
 * 但不引入 zod —— nova-code 代码库统一使用手写 validator（见 config.ts）。
 *
 * 本模块只做"单条 rule 的结构校验"；匹配逻辑在 bashRuleMatcher.ts /
 * fileRuleMatcher.ts，合并逻辑在 permissionEngine.ts，持久化在 permissionStore.ts。
 */

import type { PermissionBehavior, PermissionRule } from "../../types/permissions.ts";

/** 所有合法 behavior 的枚举常量。 */
export const PERMISSION_BEHAVIORS = [
  "allow",
  "deny",
  "ask",
] as const satisfies readonly PermissionBehavior[];

/** 类型守卫：运行时校验字符串是否是合法 PermissionBehavior。 */
export function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return typeof value === "string" && (PERMISSION_BEHAVIORS as readonly string[]).includes(value);
}

/**
 * 校验一个未知对象是否是合法 PermissionRule。
 *
 * 用于 persistedStore 加载 JSON 后的校验、斜杠命令 /permissions add 解析用户输入。
 * 失败时返回错误描述字符串；成功时返回 undefined。不抛 —— 调用方根据
 * 返回值决定是打印 warning 跳过单条 rule（加载场景）还是反馈给用户（命令场景）。
 */
export function validatePermissionRule(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `规则必须是对象，收到 ${describeType(value)}`;
  }
  const obj = value as Partial<Record<keyof PermissionRule, unknown>>;

  if (typeof obj.toolName !== "string" || obj.toolName.trim() === "") {
    return "规则缺少有效的 toolName（必须是非空字符串）";
  }

  if (obj.ruleContent !== undefined && typeof obj.ruleContent !== "string") {
    return `ruleContent 必须是字符串或缺省，收到 ${describeType(obj.ruleContent)}`;
  }

  if (!isPermissionBehavior(obj.behavior)) {
    return `behavior 必须是 allow/deny/ask 之一，收到 ${String(obj.behavior)}`;
  }

  return undefined;
}

/**
 * 把通过校验的对象转换为严格构造的 PermissionRule。
 *
 * 仅在 validatePermissionRule 返回 undefined 后调用；重复一次窄化是为了让
 * TS 拿到 readonly 形状。未通过校验直接传入会丢字段（不抛，由调用方保证）。
 */
export function normalizePermissionRule(value: unknown): PermissionRule | undefined {
  if (validatePermissionRule(value) !== undefined) return undefined;
  const obj = value as { toolName: string; ruleContent?: string; behavior: PermissionBehavior };
  const normalized: { -readonly [K in keyof PermissionRule]: PermissionRule[K] } = {
    toolName: obj.toolName,
    behavior: obj.behavior,
  };
  if (obj.ruleContent !== undefined && obj.ruleContent !== "") {
    normalized.ruleContent = obj.ruleContent;
  }
  return normalized;
}

/**
 * 规则"去重"的身份键：toolName + ruleContent（忽略 behavior）。
 *
 * 用途：
 * - store.add 时同 tool+content 的旧规则先移除再追加新 behavior
 * - engine 从 UserChoice allow-always-* 升级规则时避免重复写入
 *
 * 不把 behavior 纳入 key 的原因：同一工具+内容不应同时存在 allow 与 deny 规则 ——
 * 后写的 behavior 应覆盖前者，否则用户会陷入"到底哪条生效"的困惑。
 */
export function permissionRuleKey(rule: PermissionRule): string {
  return `${rule.toolName}\t${rule.ruleContent ?? ""}`;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
