/**
 * createReplPermissionProvider —— 把 REPL 的 readline + stderr 包装成 PermissionProvider。
 *
 * 当 QueryEngine 决策为 ask 时，本 Provider 会在 stderr 打印"权限请求摘要 +
 * 5 档选项菜单"，并用 REPL 的 readLine 等用户输入回车。空行或无效输入视为 deny。
 *
 * 与 SlashIO.confirm 不复用的原因：
 * - confirm 只能 yes/no，不够 5 档
 * - 复用 confirm 等于二次包装，这里直接吃 readLine + io 更直观
 *
 * 单测要点：readLine 接一个可 mock 的 async 函数；io 是 ReplIO 的 stdout/stderr 对象。
 * 不依赖真实 readline / TTY。
 */

import type {
  PermissionProvider,
  PermissionRequest,
} from "../../services/permissions/PermissionProvider.ts";
import type { UserChoice } from "../../types/permissions.ts";
import type { ReplIO } from "./renderAgentEvent.ts";

/** 构造 Provider 需要的外部依赖。 */
export interface ReplPermissionProviderDeps {
  readonly io: ReplIO;
  /** 读一行用户输入；EOF / close 返回 null（视为 deny）。 */
  readonly readLine: (prompt: string) => Promise<string | null>;
}

/** 构造一个面向 REPL 交互的 PermissionProvider。 */
export function createReplPermissionProvider(deps: ReplPermissionProviderDeps): PermissionProvider {
  return {
    requestPermission: async (req: PermissionRequest): Promise<UserChoice> => {
      const header = formatRequestHeader(req);
      deps.io.stderr(`\n${header}\n`);
      deps.io.stderr("  1) allow once\n");
      deps.io.stderr("  2) allow always (session)\n");
      deps.io.stderr("  3) allow always (project)\n");
      deps.io.stderr("  4) allow always (global)\n");
      deps.io.stderr("  5) deny\n");

      // 循环等有效输入；空行 / EOF / 无效输入 → 安全从严，走 deny
      while (true) {
        const line = await deps.readLine("  选择 1-5（回车=5 deny）: ");
        if (line === null) return "deny";
        const choice = parseChoice(line.trim());
        if (choice !== undefined) return choice;
        deps.io.stderr("  无效输入，请输入 1-5。\n");
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部：格式化 + 解析
// ────────────────────────────────────────────────────────────────────────────

/** 把数字字符串映射为 UserChoice；不合法时返回 undefined。 */
function parseChoice(input: string): UserChoice | undefined {
  if (input === "" || input === "5") return "deny";
  if (input === "1") return "allow-once";
  if (input === "2") return "allow-always-session";
  if (input === "3") return "allow-always-project";
  if (input === "4") return "allow-always-global";
  return undefined;
}

/** 生成请求头一行，形如 "[permission] Bash `git push` — tool requires approval"。 */
function formatRequestHeader(req: PermissionRequest): string {
  const summary = summarizeInput(req.toolName, req.input);
  const suffix = summary === "" ? "" : ` ${summary}`;
  return `[permission] ${req.toolName}${suffix} — ${req.reason}`;
}

/** 从 tool input 提取人类可读的简短摘要。 */
function summarizeInput(toolName: string, input: Readonly<Record<string, unknown>>): string {
  if (toolName === "Bash") {
    const { command } = input as { command?: unknown };
    return typeof command === "string" ? `\`${command}\`` : "";
  }
  if (toolName === "FileWrite" || toolName === "FileEdit") {
    const { file_path } = input as { file_path?: unknown };
    return typeof file_path === "string" ? file_path : "";
  }
  // 其它工具：退化为 JSON.stringify 的 short form（避免吞掉整个长 input）
  try {
    const raw = JSON.stringify(input);
    return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  } catch {
    return "";
  }
}
