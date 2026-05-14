/**
 * 会话 ID 生成器。
 *
 * M6.5 起对齐 claude-code：新会话统一使用 UUID v4。历史的
 * `<YYYY-MM-DDTHH-mm-ss>-<hex8>` 文件仍可通过 /load 或 --resume 加载；这里仅改变
 * 新建会话的 ID 生成策略。
 */

import { randomUUID } from "node:crypto";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 生成一个新的 UUID v4 sessionId。 */
export function generateSessionId(createUuid: () => string = randomUUID): string {
  const id = createUuid();
  if (!isUuidV4(id)) {
    throw new Error(`sessionId generator must return UUID v4, got: ${id}`);
  }
  return id;
}

/** 判断给定字符串是否是小写 canonical UUID v4。 */
export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}
