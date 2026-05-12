/**
 * File 规则匹配器 —— 判断 FileWrite / FileEdit 调用的路径是否匹配一条 PermissionRule。
 *
 * 对齐 claude-code/src/utils/permissions/filesystem.ts 的语义：
 * - ruleContent 是 glob 表达式（`docs/**\/*` / `src/*.ts`）
 * - 路径匹配前先相对化到 cwd，让 `docs/**\/*` 这类规则能命中绝对路径调用
 *
 * 不复用 Bun.Glob 的原因：
 * - Bun.Glob 更偏向"目录遍历"场景，match 方法行为受 dot / absolute 等选项影响
 * - 本模块只需"单 path vs 单 pattern"的纯字符串匹配，手写 glob→regex 转换
 *   更可预测且便于单测，不依赖 Bun 的版本差异
 *
 * 支持的 glob 语法（子集）：
 * - `*`    匹配除 `/` 外任意字符（含空串）
 * - `**`   匹配任意字符（含 `/`）
 * - `?`    匹配任意单个非 `/` 字符
 * - `[abc]` / `[!abc]` 字符类
 * - 其它字符按字面匹配；regex 元字符转义
 *
 * 不支持：`{a,b}` 大括号展开（用多条 rule 代替）、`!` 否定（用 deny 规则代替）。
 */

import { isAbsolute, relative, sep } from "node:path";
import type { PermissionRule } from "../../types/permissions.ts";

/** FileWrite / FileEdit 工具名 —— 与工具定义严格一致。 */
export const FILE_WRITE_TOOL_NAME = "FileWrite";
export const FILE_EDIT_TOOL_NAME = "FileEdit";

/** 判断工具名是否属于路径类写权工具（当前仅 FileWrite / FileEdit）。 */
export function isFileWriteToolName(toolName: string): boolean {
  return toolName === FILE_WRITE_TOOL_NAME || toolName === FILE_EDIT_TOOL_NAME;
}

/**
 * 从 tool input 里提取要操作的文件路径。
 *
 * FileWrite input schema: `{ path: string, content: string }`
 * FileEdit input schema: `{ path: string, old_string, new_string, replace_all? }`
 *
 * 两者都用 `path` 字段；非字符串或缺字段返回 undefined（engine 层视为"无法判定"
 * → 走后续规则，不冒然 deny）。
 */
export function extractFilePath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)["path"];
  return typeof value === "string" ? value : undefined;
}

/**
 * 判断一条 rule 是否匹配给定的文件路径。
 *
 * @param rule 待评估规则（调用方已确认 toolName ∈ {FileWrite, FileEdit}）
 * @param filePath 调用参数里的路径，可能是绝对或相对
 * @param cwd 用于相对化的基准目录（通常 process.cwd()）
 */
export function matchFileRule(rule: PermissionRule, filePath: string, cwd: string): boolean {
  const content = rule.ruleContent;
  // 无 ruleContent：匹配所有 FileWrite/FileEdit 调用
  if (content === undefined || content === "") return true;

  const normalizedPath = normalizePath(filePath, cwd);
  const regex = globToRegExp(content);
  return regex.test(normalizedPath);
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把输入路径相对化到 cwd 后再做 glob 匹配。
 *
 * - 绝对路径：取相对于 cwd 的表示（跨 mount 可能产出 "../../..." 也照常匹配）
 * - 相对路径：原样保留
 * - 统一把分隔符换成 `/`（Windows 兼容；glob 语法用 `/`）
 */
function normalizePath(filePath: string, cwd: string): string {
  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  return rel.split(sep).join("/");
}

/** regex 元字符（除 glob 自身用到的 `*` `?` `[` `]` 以外）转义。 */
const REGEX_META = /[.+^${}()|\\]/g;

/**
 * 把 glob 模式编译为等价的 RegExp。
 *
 * 关键要点：
 * 1. 先扫描 pattern，遇到 `**` 特殊处理（匹配任意含 `/`）
 * 2. `*` 只匹配除 `/` 外任意
 * 3. `?` 只匹配除 `/` 外单字符
 * 4. `[...]` 字符类保持原样（但 `[!...]` 需转成 `[^...]`）
 * 5. 其他字符对 regex 元字符转义
 *
 * 产出的 regex 带 `^...$` 锚，要求完整匹配整个路径字符串。
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    if (ch === "*") {
      // 连续两个 `*` 视为 `**`
      if (glob[i + 1] === "*") {
        // `**/` → 匹配任意层级 + 可选 `/`
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        // `**` 末尾或裸 `**`
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      // 找匹配的 ]
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        // 无配对：按字面 `[`
        re += "\\[";
        i += 1;
        continue;
      }
      let body = glob.slice(i + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body}]`;
      i = end + 1;
      continue;
    }
    // 其它字符：转义 regex 元字符
    re += ch.replace(REGEX_META, (m) => `\\${m}`);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}
