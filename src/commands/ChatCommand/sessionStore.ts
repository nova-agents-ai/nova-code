/**
 * sessionStore —— 会话 JSONL 持久化。
 *
 * 格式（对齐设计稿 §7.2）：
 *   首行 `{"kind":"meta", ...}`
 *   之后每行一条 `{"kind":"msg","role":"...","content":...}`
 *
 * 为什么用 `kind` 字段做 discriminator：
 * - 未来如果要在中间插入其他类型（如 snapshot marker、context summary），
 *   只需新增 kind 值，不破坏旧读者的"首行 meta + 其余 msg"结构
 * - 避免 meta 和 msg 共用字段时语义混淆（两者都可能出现 role/content）
 *
 * 读写约定：
 * - /save：**覆盖写整份快照**（非 append）。M2 先做最稳的形态；
 *   M14 真要持续 append 再改增量协议
 * - /save <alias>：同时把同一份 snapshot 另写一份 `<alias>.jsonl`（文件副本，
 *   不用 symlink —— 跨平台更稳，占空间忽略不计）
 * - /load <idOrAlias>：按文件名找 → 逐行 parse → 首行 meta 缺失即抛
 *
 * ConfigSource 保持与 config.ts 对齐：测试时用临时 home 注入，避免污染
 * 真实 ~/.nova-code/sessions。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ConfigSource, getSessionsDirPath } from "../../config/config.ts";
import { logEvent } from "../../services/analytics/index.ts";
import type { NovaMessage } from "../../types/message.ts";
import type { SessionMeta } from "./ChatSession.ts";

/** save/load 往返的数据容器。 */
export interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly messages: readonly NovaMessage[];
}

/**
 * 把 snapshot 写到 `<sessionsDir>/<idOrAlias>.jsonl`。
 *
 * 覆盖写；自动创建父目录。失败直接抛（Node fs 原生 Error），不再包一层
 * 自定义错误——调用方（/save 命令）会把消息展示给用户。
 */
export async function saveSession(
  idOrAlias: string,
  snapshot: SessionSnapshot,
  source: ConfigSource = {},
): Promise<string> {
  assertSafeFileName(idOrAlias);

  const dir = getSessionsDirPath(source);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${idOrAlias}.jsonl`);

  const lines: string[] = [];
  lines.push(JSON.stringify({ kind: "meta", ...snapshot.meta }));
  for (const msg of snapshot.messages) {
    lines.push(JSON.stringify({ kind: "msg", role: msg.role, content: msg.content }));
  }
  // 末尾加换行：POSIX 工具 (cat/tail) 通常期望文件以 \n 结尾
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

/**
 * 从 `<sessionsDir>/<idOrAlias>.jsonl` 读回 snapshot。
 *
 * 容错策略：
 * - 空行直接跳过（便于人工 vim 编辑后保留空白）
 * - 首条非空行必须是 `{"kind":"meta", ...}`，否则抛
 * - 非法 JSON / 非预期 kind / 字段缺失 → 抛带行号的错，便于定位
 */
export async function loadSession(
  idOrAlias: string,
  source: ConfigSource = {},
): Promise<SessionSnapshot> {
  assertSafeFileName(idOrAlias);

  const dir = getSessionsDirPath(source);
  const path = join(dir, `${idOrAlias}.jsonl`);
  const raw = await readFile(path, "utf8");

  const lines = raw.split("\n");
  let meta: SessionMeta | undefined;
  const messages: NovaMessage[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSONL at ${path}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected object at ${path}:${i + 1}, got ${typeof parsed}.`);
    }
    const obj = parsed as { kind?: unknown } & Record<string, unknown>;

    if (obj.kind === "meta") {
      if (meta !== undefined) {
        throw new Error(`Duplicate meta at ${path}:${i + 1}; only the first line may be meta.`);
      }
      meta = readMeta(obj, path, i + 1);
    } else if (obj.kind === "msg") {
      if (meta === undefined) {
        throw new Error(
          `Expected first non-empty line to be meta at ${path}:${i + 1}, got kind=msg.`,
        );
      }
      messages.push(readMessage(obj, path, i + 1));
    } else {
      throw new Error(
        `Unknown kind=${String(obj.kind)} at ${path}:${i + 1}; expected "meta" or "msg".`,
      );
    }
  }

  if (meta === undefined) {
    throw new Error(`Empty or meta-less session file: ${path}`);
  }
  logEvent("tengu_session_file_read", {
    messageCount: messages.length,
  });
  return { meta, messages };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

/**
 * 防目录穿越：idOrAlias 不允许含路径分隔符或以 `.` 开头。
 *
 * 用户在 /save alias-a 或 /load sess-xxx 时按约定只填文件名本身；
 * 即便恶意或手滑也不会写到 sessions 目录之外。
 */
function assertSafeFileName(name: string): void {
  if (name === "") {
    throw new Error("session id/alias must not be empty");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`unsafe session id/alias: ${name} (no path separators allowed)`);
  }
  if (name.startsWith(".")) {
    throw new Error(`session id/alias must not start with '.': ${name}`);
  }
}

function readMeta(obj: Record<string, unknown>, path: string, lineNo: number): SessionMeta {
  // noPropertyAccessFromIndexSignature 下直接 obj.sessionId 会报；
  // 先窄化为已知键 union 再访问，顺便跳过 biome useLiteralKeys 投诉
  const known = obj as Partial<Record<keyof SessionMeta, unknown>>;
  const sessionId = known.sessionId;
  const model = known.model;
  const createdAt = known.createdAt;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error(`meta.sessionId must be non-empty string at ${path}:${lineNo}`);
  }
  if (typeof model !== "string" || model === "") {
    throw new Error(`meta.model must be non-empty string at ${path}:${lineNo}`);
  }
  if (typeof createdAt !== "string" || createdAt === "") {
    throw new Error(`meta.createdAt must be non-empty string at ${path}:${lineNo}`);
  }
  return { sessionId, model, createdAt };
}

function readMessage(obj: Record<string, unknown>, path: string, lineNo: number): NovaMessage {
  const known = obj as Partial<Record<"role" | "content", unknown>>;
  const role = known.role;
  const content = known.content;
  if (role !== "user" && role !== "assistant") {
    throw new Error(
      `msg.role must be 'user' or 'assistant' at ${path}:${lineNo}, got ${String(role)}`,
    );
  }
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new Error(`msg.content must be string or array at ${path}:${lineNo}`);
  }
  // NovaMessage.content 已容纳 string | readonly NovaContentBlock[]；
  // 这里不深度校验每个 block 的字段——约定调用方（ChatSession）只写出合法结构，
  // 用户手改文件出问题也能由 SDK 请求阶段兜底报错
  return { role, content } as NovaMessage;
}
