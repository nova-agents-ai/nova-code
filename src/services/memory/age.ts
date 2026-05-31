/**
 * 记忆新鲜度（age）工具。
 *
 * 对齐 claude-code/src/memdir/memoryAge.ts：模型对绝对时间戳不敏感，
 * 用"47 days ago" / "today" / "yesterday"这类相对短语能更好触发"这条记忆可能
 * 已过时，需要先验证"的判断。
 */

const MS_PER_DAY = 86_400_000;

/**
 * 从 mtime 到现在的天数（floor）。负数（时钟漂移 / 未来 mtime）夹到 0。
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / MS_PER_DAY));
}

/**
 * 人类可读的相对时间短语。
 *
 * 0 → "today"，1 → "yesterday"，2+ → "N days ago"
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/**
 * stale 记忆的告诫文本（>1 天才返回）。
 *
 * 用户报告过 stale 代码状态记忆（file:line 引用）被当成事实强行断言；带 cite
 * 让 stale 断言听起来更权威，反而更糟。这段文本明确提醒模型先验证再断言。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return "";
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}
