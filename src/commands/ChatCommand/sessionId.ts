/**
 * 会话 ID 生成器。
 *
 * 格式：`<ISO-YYYY-MM-DDTHH-mm-ss>-<randomHex8>`
 *
 * 设计动机（对齐设计稿 §7.3）：
 * - 前缀用秒级 ISO 时间 → 字典序即时序，`ls -1 ~/.nova-code/sessions | tail`
 *   就能找最近会话，便于调试与人工恢复
 * - 后缀用 4 字节随机 hex（8 字符）→ 同秒并发创建也不会撞，且短得不占眼
 * - 完全同步，不引异步依赖；new Date()/randomBytes 都在 node:crypto 之内
 *
 * 注意：冒号、斜杠等会让文件名在某些 shell 上需要转义；这里统一用 `-`
 * 把 HH:mm:ss 也替成 HH-mm-ss，文件路径更友好。
 */

import { randomBytes } from "node:crypto";

/**
 * 生成一个新的 sessionId。
 *
 * @param now - 注入当前时间，方便单测确定性断言。生产代码不传（默认 new Date()）。
 * @param random - 注入随机字节生成器，方便单测固定 hex 后缀。
 */
export function generateSessionId(
  now: Date = new Date(),
  random: (size: number) => Buffer = randomBytes,
): string {
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  const ts =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const suffix = random(4).toString("hex");
  return `${ts}-${suffix}`;
}
