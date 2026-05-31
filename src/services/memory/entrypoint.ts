/**
 * MEMORY.md 加载与截断。
 *
 * 对齐 claude-code/src/memdir/memdir.ts 的 truncateEntrypointContent。
 *
 * 两道门：
 *   1. 行数门 MAX_ENTRYPOINT_LINES = 200（防止索引膨胀）
 *   2. 字节门 MAX_ENTRYPOINT_BYTES = 25_000（防止极长单行索引滑过行数门）
 *
 * 任一门命中即截断，并在末尾追加 warning 说明哪个门触发，引导用户把索引保持简短。
 */

const FILESIZE_KB = 1024;

export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

export interface EntrypointTruncation {
  readonly content: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly wasLineTruncated: boolean;
  readonly wasByteTruncated: boolean;
}

/**
 * 把原始 MEMORY.md 内容按两道门截断；不触发任何门时原样返回（trim）。
 *
 * 行数截断先于字节截断（自然边界）；字节截断时尽量在最后一个换行处切，避免
 * 切到一行中间。
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    };
  }

  let truncated = wasLineTruncated ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason = buildReason({ byteCount, lineCount, wasLineTruncated, wasByteTruncated });
  return {
    content: `${truncated}\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

interface ReasonInput {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly wasLineTruncated: boolean;
  readonly wasByteTruncated: boolean;
}

function buildReason(input: ReasonInput): string {
  if (input.wasByteTruncated && !input.wasLineTruncated) {
    return `${formatBytes(input.byteCount)} (limit: ${formatBytes(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`;
  }
  if (input.wasLineTruncated && !input.wasByteTruncated) {
    return `${input.lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`;
  }
  return `${input.lineCount} lines and ${formatBytes(input.byteCount)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < FILESIZE_KB) return `${bytes} B`;
  return `${(bytes / FILESIZE_KB).toFixed(1)} KB`;
}
