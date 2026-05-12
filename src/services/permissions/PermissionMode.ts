/**
 * PermissionMode 常量与校验辅助。
 *
 * 对齐 claude-code/src/utils/permissions/PermissionMode.ts 的 shape，
 * 但只保留 nova-code M3 需要的 4 档。
 *
 * 放在 services/permissions/ 而非 types/ 的原因：
 * - types/permissions.ts 只放纯类型（string literal union）
 * - 常量列表、isPermissionMode 类型守卫带运行时逻辑，归属服务实现层
 */

import type { PermissionMode } from "../../types/permissions.ts";

/** 所有合法 mode 的枚举常量，供校验 / CLI 提示使用。 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const satisfies readonly PermissionMode[];

/** 类型守卫：运行时校验字符串是否是合法 PermissionMode。 */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * 把可能的 mode 字符串解析为 PermissionMode；非法值返回 undefined。
 *
 * 供 `/permissions mode <x>` 斜杠命令解析用户输入。
 */
export function parsePermissionMode(value: string): PermissionMode | undefined {
  return isPermissionMode(value) ? value : undefined;
}
