import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { findRelevantMemories } from "./relevance.ts";

const SIGNAL = new AbortController().signal;

interface MockArgs {
  readonly response: string;
}

/** 极简 Anthropic mock client：单次 messages.create 返回固定 text。 */
function mockClient(args: MockArgs): { client: Anthropic; lastInput?: unknown } {
  const captured: { lastInput?: unknown } = {};
  const client = {
    messages: {
      create: async (input: unknown) => {
        captured.lastInput = input;
        return {
          content: [{ type: "text", text: args.response }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, lastInput: captured.lastInput };
}

async function buildMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "novamem-rel-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe("findRelevantMemories", () => {
  test("空目录 → 空数组（不调 LLM）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-rel-empty-"));
    try {
      const { client } = mockClient({ response: "{}" });
      const result = await findRelevantMemories({
        query: "refactor",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("正常路径：返回 2 条选中", async () => {
    const dir = await buildMemoryDir({
      "a.md": "---\nname: a\ndescription: about feature A\ntype: user\n---\n",
      "b.md": "---\nname: b\ndescription: about feature B\ntype: feedback\n---\n",
      "c.md": "---\nname: c\ndescription: about feature C\ntype: project\n---\n",
    });
    try {
      const { client } = mockClient({
        response: '{"selected_memories":["a.md","c.md"]}',
      });
      const result = await findRelevantMemories({
        query: "tell me about A",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result.map((r) => r.path)).toEqual([join(dir, "a.md"), join(dir, "c.md")]);
      // 每条都带 mtime
      expect(result.every((r) => r.mtimeMs > 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("alreadySurfaced 过滤：不再选中已经注入过的", async () => {
    const dir = await buildMemoryDir({
      "a.md": "---\nname: a\n---\n",
      "b.md": "---\nname: b\n---\n",
    });
    try {
      const surfacedPath = join(dir, "a.md");
      const { client } = mockClient({
        response: '{"selected_memories":["a.md","b.md"]}',
      });
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
        alreadySurfaced: new Set([surfacedPath]),
      });
      // a.md 被过滤；只剩 b.md
      expect(result.map((r) => r.path)).toEqual([join(dir, "b.md")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LLM 返回非法 filename → 过滤掉", async () => {
    const dir = await buildMemoryDir({ "a.md": "---\nname: a\n---\n" });
    try {
      const { client } = mockClient({
        response: '{"selected_memories":["a.md","nonexistent.md","../etc/passwd"]}',
      });
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result.map((r) => r.path)).toEqual([join(dir, "a.md")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LLM 返回散文包裹的 JSON → 仍能解析", async () => {
    const dir = await buildMemoryDir({ "a.md": "---\nname: a\n---\n" });
    try {
      const { client } = mockClient({
        response: 'Sure, here is the selection:\n```json\n{"selected_memories":["a.md"]}\n```',
      });
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result.map((r) => r.path)).toEqual([join(dir, "a.md")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LLM 返回空选择 → 空数组", async () => {
    const dir = await buildMemoryDir({ "a.md": "---\nname: a\n---\n" });
    try {
      const { client } = mockClient({ response: '{"selected_memories":[]}' });
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LLM 返回非 JSON → 空数组（容错）", async () => {
    const dir = await buildMemoryDir({ "a.md": "---\nname: a\n---\n" });
    try {
      const { client } = mockClient({ response: "I don't know which to pick" });
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LLM 抛错 → 空数组（不冒泡）", async () => {
    const dir = await buildMemoryDir({ "a.md": "---\nname: a\n---\n" });
    try {
      const client = {
        messages: {
          create: async () => {
            throw new Error("API down");
          },
        },
      } as unknown as Anthropic;
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("signal aborted → 空数组（不冒泡）", async () => {
    const dir = await buildMemoryDir({ "a.md": "---\nname: a\n---\n" });
    try {
      const ac = new AbortController();
      const client = {
        messages: {
          create: async () => {
            ac.abort();
            throw new Error("aborted");
          },
        },
      } as unknown as Anthropic;
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: ac.signal,
      });
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("最多返回 MAX_SELECTED (5) 条", async () => {
    const files: Record<string, string> = {};
    const selectedList: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      files[`m${i}.md`] = `---\nname: m${i}\n---\n`;
      selectedList.push(`m${i}.md`);
    }
    const dir = await buildMemoryDir(files);
    try {
      const { client } = mockClient({
        response: JSON.stringify({ selected_memories: selectedList }),
      });
      const result = await findRelevantMemories({
        query: "x",
        memoryDir: dir,
        client,
        model: "test-model",
        signal: SIGNAL,
      });
      expect(result.length).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
