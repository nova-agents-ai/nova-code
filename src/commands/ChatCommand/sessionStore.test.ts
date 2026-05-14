/**
 * sessionStore 单元测试。
 *
 * 测试策略：mkdtemp 做临时 home，走 ConfigSource.homeDir 注入，绝不碰真实 ~/.nova-code。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageRoleEnum, type NovaMessage } from "../../types/message.ts";
import type { SessionMeta } from "./ChatSession.ts";
import { loadSession, type SessionSnapshot, saveSession } from "./sessionStore.ts";

async function makeTempHome(): Promise<{
  homeDir: string;
  cleanup: () => Promise<void>;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "nova-code-session-test-"));
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  };
}

const FIXED_META: SessionMeta = {
  sessionId: "3f4e2b70-8f4a-4d47-9e4f-2c3b7f7a8e10",
  model: "claude-test",
  createdAt: "2026-05-04T10:00:00.000Z",
};

describe("sessionStore - save/load 往返", () => {
  test("空 messages 也能保存与加载", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const snap: SessionSnapshot = { meta: FIXED_META, messages: [] };
      await saveSession(FIXED_META.sessionId, snap, { homeDir });
      const loaded = await loadSession(FIXED_META.sessionId, { homeDir });
      expect(loaded).toEqual(snap);
    } finally {
      await cleanup();
    }
  });

  test("历史 timestamp sessionId 文件仍可加载（M6.5 向后兼容）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const legacyMeta: SessionMeta = {
        ...FIXED_META,
        sessionId: "2026-05-04T10-00-00-deadbeef",
      };
      const snap: SessionSnapshot = { meta: legacyMeta, messages: [] };
      await saveSession(legacyMeta.sessionId, snap, { homeDir });
      const loaded = await loadSession(legacyMeta.sessionId, { homeDir });
      expect(loaded.meta.sessionId).toBe(legacyMeta.sessionId);
    } finally {
      await cleanup();
    }
  });

  test("多轮 messages（含 tool_use / tool_result）完整往返", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const messages: NovaMessage[] = [
        { role: MessageRoleEnum.USER, content: "use echo" },
        {
          role: MessageRoleEnum.ASSISTANT,
          content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { m: "x" } }],
        },
        {
          role: MessageRoleEnum.USER,
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "echo: x" }],
        },
        {
          role: MessageRoleEnum.ASSISTANT,
          content: [{ type: "text", text: "done" }],
        },
      ];
      const snap: SessionSnapshot = { meta: FIXED_META, messages };
      await saveSession(FIXED_META.sessionId, snap, { homeDir });
      const loaded = await loadSession(FIXED_META.sessionId, { homeDir });
      expect(loaded).toEqual(snap);
    } finally {
      await cleanup();
    }
  });

  test("保留 is_error=true 字段", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const messages: NovaMessage[] = [
        { role: MessageRoleEnum.USER, content: "run fail" },
        {
          role: MessageRoleEnum.USER,
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }],
        },
      ];
      const snap: SessionSnapshot = { meta: FIXED_META, messages };
      await saveSession("fail-case", snap, { homeDir });
      const loaded = await loadSession("fail-case", { homeDir });
      // biome-ignore lint/style/noNonNullAssertion: array literal access at known index is safe
      expect(loaded.messages[1]).toEqual(messages[1]!);
    } finally {
      await cleanup();
    }
  });

  test("alias 参数让同一份 snapshot 写到另一个文件（文件副本，而非 symlink）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const snap: SessionSnapshot = {
        meta: FIXED_META,
        messages: [{ role: MessageRoleEnum.USER, content: "hi" }],
      };
      await saveSession(FIXED_META.sessionId, snap, { homeDir });
      await saveSession("alias-a", snap, { homeDir });

      const byId = await loadSession(FIXED_META.sessionId, { homeDir });
      const byAlias = await loadSession("alias-a", { homeDir });
      expect(byId).toEqual(byAlias);
    } finally {
      await cleanup();
    }
  });

  test("覆盖写：第二次 save 会替换首次内容", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const first: SessionSnapshot = {
        meta: FIXED_META,
        messages: [{ role: MessageRoleEnum.USER, content: "v1" }],
      };
      const second: SessionSnapshot = {
        meta: FIXED_META,
        messages: [{ role: MessageRoleEnum.USER, content: "v2" }],
      };
      await saveSession(FIXED_META.sessionId, first, { homeDir });
      await saveSession(FIXED_META.sessionId, second, { homeDir });
      const loaded = await loadSession(FIXED_META.sessionId, { homeDir });
      expect(loaded.messages).toEqual(second.messages);
    } finally {
      await cleanup();
    }
  });
});

describe("sessionStore - 文件格式断言", () => {
  test("首行是 meta，之后每行一条 msg，都带 kind 字段", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const snap: SessionSnapshot = {
        meta: FIXED_META,
        messages: [
          { role: MessageRoleEnum.USER, content: "hi" },
          { role: MessageRoleEnum.ASSISTANT, content: [{ type: "text", text: "hello" }] },
        ],
      };
      const path = await saveSession(FIXED_META.sessionId, snap, { homeDir });
      const raw = await readFile(path, "utf8");
      const lines = raw.trimEnd().split("\n");
      expect(lines.length).toBe(3);

      // biome-ignore lint/style/noNonNullAssertion: lines.length asserted above
      const meta = JSON.parse(lines[0]!);
      expect(meta.kind).toBe("meta");
      expect(meta.sessionId).toBe(FIXED_META.sessionId);

      // biome-ignore lint/style/noNonNullAssertion: lines.length asserted above
      const msg1 = JSON.parse(lines[1]!);
      expect(msg1.kind).toBe("msg");
      expect(msg1.role).toBe("user");
    } finally {
      await cleanup();
    }
  });
});

describe("sessionStore - 错误场景", () => {
  test("文件不存在 → 抛 ENOENT 错", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      await expect(loadSession("nope", { homeDir })).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("损坏的 JSONL（某行不是合法 JSON）→ 抛带行号的错", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const dir = join(homeDir, ".nova-code", "sessions");
      await mkdir(dir, { recursive: true });
      const path = join(dir, "bad.jsonl");
      await writeFile(
        path,
        `${JSON.stringify({ kind: "meta", ...FIXED_META })}\n{ not valid json\n`,
        "utf8",
      );
      await expect(loadSession("bad", { homeDir })).rejects.toThrow(/Invalid JSONL.*:2/);
    } finally {
      await cleanup();
    }
  });

  test("首行非 meta → 抛", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const dir = join(homeDir, ".nova-code", "sessions");
      await mkdir(dir, { recursive: true });
      const path = join(dir, "no-meta.jsonl");
      await writeFile(
        path,
        `${JSON.stringify({ kind: "msg", role: "user", content: "x" })}\n`,
        "utf8",
      );
      await expect(loadSession("no-meta", { homeDir })).rejects.toThrow(/Expected first.*meta/);
    } finally {
      await cleanup();
    }
  });

  test("空文件 → 抛 'meta-less'", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const dir = join(homeDir, ".nova-code", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "empty.jsonl"), "", "utf8");
      await expect(loadSession("empty", { homeDir })).rejects.toThrow(/meta-less/);
    } finally {
      await cleanup();
    }
  });

  test("包含路径分隔符的 id/alias → 拒绝（防目录穿越）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const snap: SessionSnapshot = { meta: FIXED_META, messages: [] };
      await expect(saveSession("../evil", snap, { homeDir })).rejects.toThrow(/unsafe/);
      await expect(saveSession("a/b", snap, { homeDir })).rejects.toThrow(/unsafe/);
      await expect(loadSession("../etc/passwd", { homeDir })).rejects.toThrow(/unsafe/);
    } finally {
      await cleanup();
    }
  });

  test("空行被跳过（便于 vim 编辑后保留空白）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const dir = join(homeDir, ".nova-code", "sessions");
      await mkdir(dir, { recursive: true });
      const path = join(dir, "with-blanks.jsonl");
      const content =
        `${JSON.stringify({ kind: "meta", ...FIXED_META })}\n` +
        `\n` +
        `${JSON.stringify({ kind: "msg", role: "user", content: "hi" })}\n` +
        `\n`;
      await writeFile(path, content, "utf8");
      const loaded = await loadSession("with-blanks", { homeDir });
      expect(loaded.messages.length).toBe(1);
      expect(loaded.messages[0]).toEqual({ role: MessageRoleEnum.USER, content: "hi" });
    } finally {
      await cleanup();
    }
  });
});
