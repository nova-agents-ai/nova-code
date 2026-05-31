/**
 * Memory 目录扫描。
 *
 * 对齐 claude-code/src/memdir/memoryScan.ts：递归扫 `.md`、剔除 MEMORY.md、
 * 读 frontmatter、按 mtime 倒序、上限 200 个。
 *
 * 实现差异（vs claude-code）：
 *   - claude-code 用 readFileInRange(0, FRONTMATTER_MAX_LINES) 只读头 30 行
 *     + 同步带回 mtimeMs；nova-code 不引入该 helper，用 fs.stat + Bun.file
 *     读全文（memory 文件通常 < 2KB；偶尔大文件也只解析前 8KB），开销可接受。
 *   - claude-code 用 Promise.allSettled；这里用同款语义但 reject 计入 warnings
 *     而非静默吞，便于 --debug 排查。
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMemoryDocument } from "./frontmatter.ts";
import { ENTRYPOINT_NAME } from "./paths.ts";
import { type MemoryHeader, parseMemoryType } from "./types.ts";

/** 单次扫描最多保留的记忆文件数（按 mtime 倒序保留最新的）。 */
const MAX_MEMORY_FILES = 200;

/** 单文件解析时只看前 N 字节（远超 frontmatter + description 所需的字节数）。 */
const FRONTMATTER_READ_BYTES = 8 * 1024;

/**
 * 扫描 memoryDir 下所有 `.md` 文件（剔除 MEMORY.md 索引），返回头信息列表。
 *
 * - 递归扫子目录（支持将来 team / topic 分组）
 * - mtime 倒序，截断到前 MAX_MEMORY_FILES 条
 * - 单文件失败不影响整体扫描，静默丢弃（与 claude-code 行为一致）
 * - signal.aborted 不在中途中断（readdir / stat 是快速操作）；签名保留 signal
 *   是为后续如果切到 streaming 读时能接住中断
 */
export async function scanMemoryFiles(
  memoryDir: string,
  _signal: AbortSignal,
): Promise<readonly MemoryHeader[]> {
  let entries: readonly string[];
  try {
    entries = (await readdir(memoryDir, { recursive: true })) as readonly string[];
  } catch {
    return [];
  }

  const candidates = entries.filter(
    (relativePath) => relativePath.endsWith(".md") && basename(relativePath) !== ENTRYPOINT_NAME,
  );

  const results = await Promise.allSettled(
    candidates.map((relativePath) => loadHeader(memoryDir, relativePath)),
  );

  const headers: MemoryHeader[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== undefined) {
      headers.push(r.value);
    }
  }
  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES);
}

async function loadHeader(
  memoryDir: string,
  relativePath: string,
): Promise<MemoryHeader | undefined> {
  const filePath = join(memoryDir, relativePath);
  let mtimeMs: number;
  let content: string;
  try {
    const [statResult, textResult] = await Promise.all([
      stat(filePath),
      readPartial(filePath, FRONTMATTER_READ_BYTES),
    ]);
    if (!statResult.isFile()) return undefined;
    mtimeMs = statResult.mtimeMs;
    content = textResult;
  } catch {
    return undefined;
  }

  const { frontmatter } = parseMemoryDocument(content);
  const description = frontmatter["description"];
  return {
    filename: relativePath,
    filePath,
    mtimeMs,
    description: typeof description === "string" && description !== "" ? description : null,
    type: parseMemoryType(frontmatter["type"]),
  };
}

async function readPartial(filePath: string, maxBytes: number): Promise<string> {
  const file = Bun.file(filePath);
  if (file.size <= maxBytes) {
    return await file.text();
  }
  const slice = file.slice(0, maxBytes);
  return await slice.text();
}

/**
 * 把扫描结果格式化成 LLM-friendly 清单：每行一条
 *   `- [type] filename.md (ISO timestamp): description`
 *
 * 用于：
 * 1. relevance selector 的 manifest（让 Sonnet/Haiku 知道有哪些候选）
 * 2. extractor 的预注入清单（让子 agent 写 memory 前知道哪些文件已存在，避免重复）
 */
export function formatMemoryManifest(memories: readonly MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type !== undefined ? `[${m.type}] ` : "";
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description !== null
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`;
    })
    .join("\n");
}
