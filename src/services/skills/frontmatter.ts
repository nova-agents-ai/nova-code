/**
 * M9 skill frontmatter 解析器。
 *
 * 只实现当前 skill 生态实际使用到的 YAML 子集：顶层 key/value、block scalar、
 * 简单数组与基础 scalar。保持零依赖，避免为 prompt 包加载引入完整 YAML runtime。
 */

export interface ParsedSkillDocument {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

const FRONTMATTER_MARKER = "---";

export function parseSkillDocument(content: string): ParsedSkillDocument {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const first = lines[0];
  if (first?.trim() !== FRONTMATTER_MARKER) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const closeIndex = findFrontmatterClose(lines);
  if (closeIndex === undefined) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const rawFrontmatter = lines.slice(1, closeIndex).join("\n");
  const body = lines
    .slice(closeIndex + 1)
    .join("\n")
    .trim();
  return { frontmatter: parseFrontmatter(rawFrontmatter), body };
}

function findFrontmatterClose(lines: readonly string[]): number | undefined {
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FRONTMATTER_MARKER) return i;
  }
  return undefined;
}

export function parseFrontmatter(raw: string): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  const lines = raw.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (shouldSkipLine(line)) {
      index += 1;
      continue;
    }

    const field = parseFieldLine(line);
    if (field === undefined) {
      index += 1;
      continue;
    }

    if (field.value === "|" || field.value === ">") {
      const block = collectIndentedBlock(lines, index + 1);
      entries[field.key] = formatBlockScalar(block.lines, field.value);
      index = block.nextIndex;
      continue;
    }

    if (field.value === "") {
      const list = collectList(lines, index + 1);
      entries[field.key] = list.values.length > 0 ? list.values : "";
      index = list.nextIndex;
      continue;
    }

    entries[field.key] = parseScalar(field.value);
    index += 1;
  }

  return entries;
}

function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseFieldLine(
  line: string,
): { readonly key: string; readonly value: string } | undefined {
  const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
  const key = match?.[1];
  if (key === undefined) return undefined;
  return { key, value: match?.[2] ?? "" };
}

function collectIndentedBlock(
  lines: readonly string[],
  startIndex: number,
): { readonly lines: readonly string[]; readonly nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && !/^\s+/.test(line)) break;
    collected.push(line);
    index += 1;
  }
  return { lines: stripCommonIndent(collected), nextIndex: index };
}

function collectList(
  lines: readonly string[],
  startIndex: number,
): { readonly values: readonly string[]; readonly nextIndex: number } {
  const values: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const match = /^\s*-\s*(.*)$/.exec(line);
    if (match === null) break;
    values.push(String(parseScalar(match[1] ?? "")));
    index += 1;
  }
  return { values, nextIndex: index };
}

function stripCommonIndent(lines: readonly string[]): readonly string[] {
  const nonEmptyIndents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = Math.min(...nonEmptyIndents, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(minIndent) || minIndent <= 0) return lines;
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(minIndent)));
}

function formatBlockScalar(lines: readonly string[], marker: "|" | ">") {
  if (marker === ">") {
    return lines
      .map((line) => line.trim())
      .join(" ")
      .trim();
  }
  return lines.join("\n").trim();
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return "";
  if (isQuoted(value)) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return parseInlineArray(value);
  return value;
}

function isQuoted(value: string): boolean {
  return (
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  );
}

function parseInlineArray(value: string): readonly string[] {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((item) => String(parseScalar(item.trim())));
}
