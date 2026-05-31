/**
 * 极简 YAML frontmatter parser，专为 memory 文件设计。
 *
 * 与 services/skills/frontmatter.ts 的区别：
 * - skills 的 frontmatter 需要 block scalar / 列表 / 嵌套，所以解析逻辑较多
 * - memory frontmatter 只用 `name` / `description` / `type` 三个 string 字段
 *
 * 这里只解析"顶层 key: value 一行字符串"的简单子集，无依赖、易测。
 * 未覆盖的语法（多行、列表、嵌套）一律忽略，不抛错——legacy 文件随便写
 * 也能继续工作，selector 不依赖完整解析。
 */

const FRONTMATTER_MARKER = "---";

export interface ParsedMemoryDocument {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * 解析一段 `.md` 文本，返回 frontmatter 字典与正文。
 *
 * 文档无 frontmatter 块或闭合标记缺失时，frontmatter 视为空，正文保持原样。
 */
export function parseMemoryDocument(content: string): ParsedMemoryDocument {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const first = lines[0];
  if (first?.trim() !== FRONTMATTER_MARKER) {
    return { frontmatter: {}, body: normalized };
  }

  const closeIndex = findClose(lines);
  if (closeIndex === undefined) {
    return { frontmatter: {}, body: normalized };
  }

  const rawFrontmatter = lines.slice(1, closeIndex).join("\n");
  const body = lines.slice(closeIndex + 1).join("\n");
  return { frontmatter: parseFields(rawFrontmatter), body };
}

function findClose(lines: readonly string[]): number | undefined {
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FRONTMATTER_MARKER) return i;
  }
  return undefined;
}

function parseFields(raw: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
    const key = match?.[1];
    if (key === undefined) continue;
    entries[key] = unquote(match?.[2] ?? "").trim();
  }
  return entries;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length < 2) return v;
  const first = v[0];
  const last = v[v.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return v.slice(1, -1);
  }
  return v;
}
