/**
 * Memory 类型定义。
 *
 * 对齐 claude-code/src/memdir/memoryTypes.ts 的 4 类记忆枚举，以及 memoryScan.ts
 * 的 MemoryHeader / findRelevantMemories.ts 的 RelevantMemory shape。命名与
 * 字段尽量同形，便于将来对齐 upstream 时直接复用。
 *
 * 4 类记忆刻意收紧到"代码不可推导的内容"：
 * - user      用户角色 / 偏好 / 知识背景
 * - feedback  用户给过的纠正与确认（带 Why + How to apply）
 * - project   工作进展 / 决策 / 截止（含绝对日期）
 * - reference 外部系统指针（Linear / Slack / Grafana 等）
 *
 * 详见 docs/design/M16-memory.md §3。
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * 把 frontmatter 中 type 字段的原始值解析为合法的 MemoryType。
 * 非法 / 缺失返回 undefined：legacy 文件不带 type 字段也能继续工作；
 * 未知 type 优雅降级，不抛错。
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== "string") return undefined;
  return MEMORY_TYPES.find((t) => t === raw);
}

/**
 * 扫描记忆目录后得到的单条记忆头信息。
 *
 * - filename 是相对 memoryDir 的路径，可能带子目录（如 `team/foo.md` —— 当前
 *   M16 未启用 team 子目录，但 scan 不做过滤，保持兼容）
 * - filePath 是绝对路径
 * - mtimeMs 用作排序与新鲜度判定
 * - description 来自 frontmatter；缺失为 null
 * - type 缺失或非法为 undefined
 */
export interface MemoryHeader {
  readonly filename: string;
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly description: string | null;
  readonly type: MemoryType | undefined;
}

/**
 * findRelevantMemories 的返回项：被 selector 选中的最相关文件的路径与 mtime。
 * mtime 一并返回避免下游再 stat 一次。
 */
export interface RelevantMemory {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * readMemoriesForSurfacing 的返回项：真正读出内容后，准备注入到 user content
 * 的完整 surface block。header 是 `Memory (saved 2 days ago): /path:` 这类一行
 * 文本；content 是文件正文（可能被 MAX_MEMORY_BYTES 截断）。
 */
export interface SurfacedMemory {
  readonly path: string;
  readonly content: string;
  readonly mtimeMs: number;
  readonly header: string;
}
