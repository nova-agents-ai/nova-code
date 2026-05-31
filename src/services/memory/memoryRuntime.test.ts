import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  createMemoryRuntime,
  isDisabledRuntime,
  renderRelevantMemoriesAsSystemReminder,
} from "./memoryRuntime.ts";
import type { SurfacedMemory } from "./types.ts";

const SIGNAL = new AbortController().signal;

interface MockOptions {
  readonly response?: string;
  readonly throws?: boolean;
}

function mockClient(opts: MockOptions): Anthropic {
  return {
    messages: {
      create: async () => {
        if (opts.throws === true) throw new Error("api down");
        return {
          content: [{ type: "text", text: opts.response ?? '{"selected_memories":[]}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  } as unknown as Anthropic;
}

async function freshCwd(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("createMemoryRuntime — disabled", () => {
  test("env 关闭 → disabled runtime", async () => {
    const cwd = await freshCwd("novamem-rt-env-off-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({}),
        model: "test-model",
        cwd,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      });
      expect(isDisabledRuntime(runtime)).toBe(true);
      expect(runtime.getInstructions()).toBeUndefined();
      expect(await runtime.resolveRelevantMemories("x", SIGNAL)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("config 关闭 → disabled runtime", async () => {
    const cwd = await freshCwd("novamem-rt-cfg-off-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({}),
        model: "test-model",
        autoMemoryEnabled: false,
        cwd,
        env: {},
      });
      expect(isDisabledRuntime(runtime)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("createMemoryRuntime — enabled", () => {
  test("默认开 → getInstructions 含 4 type 指令", async () => {
    const home = await freshCwd("novamem-rt-home-");
    const cwd = await freshCwd("novamem-rt-cwd-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({}),
        model: "test-model",
        cwd,
        env: { NOVA_MEMORY_DIR: join(home, ".nova-code", "memory") },
      });
      expect(isDisabledRuntime(runtime)).toBe(false);
      const text = runtime.getInstructions();
      if (text === undefined) throw new Error("expected instructions");
      expect(text).toContain("# auto memory");
      expect(text).toContain("<name>feedback</name>");
      expect(text).toContain("currently empty");
      // memoryDir 应在 home 之下
      expect(runtime.memoryDir).toContain(home);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("refresh 后能看到新写入的 MEMORY.md", async () => {
    const home = await freshCwd("novamem-rt-refresh-home-");
    const cwd = await freshCwd("novamem-rt-refresh-cwd-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({}),
        model: "test-model",
        cwd,
        env: { NOVA_MEMORY_DIR: join(home, ".nova-code", "memory") },
      });
      const before = runtime.getInstructions();
      if (before === undefined) throw new Error("expected instructions before refresh");
      expect(before).toContain("currently empty");

      await writeFile(runtime.entrypointPath, "- [foo](foo.md) — bar\n");
      await runtime.refreshInstructions();
      const after = runtime.getInstructions();
      if (after === undefined) throw new Error("expected instructions after refresh");
      expect(after).toContain("[foo](foo.md)");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveRelevantMemories：读出选中内容 + header", async () => {
    const home = await freshCwd("novamem-rt-resolve-home-");
    const cwd = await freshCwd("novamem-rt-resolve-cwd-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({ response: '{"selected_memories":["a.md"]}' }),
        model: "test-model",
        cwd,
        env: { NOVA_MEMORY_DIR: join(home, ".nova-code", "memory") },
      });
      await writeFile(join(runtime.memoryDir, "a.md"), "---\nname: a\n---\nA content");

      const result = await runtime.resolveRelevantMemories("query", SIGNAL);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toContain("A content");
      expect(result[0]?.header).toMatch(/Memory \(saved (today|yesterday|\d+ days ago)\)/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("markSurfaced 后再次 resolve 跳过该路径", async () => {
    const home = await freshCwd("novamem-rt-skip-home-");
    const cwd = await freshCwd("novamem-rt-skip-cwd-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({ response: '{"selected_memories":["a.md","b.md"]}' }),
        model: "test-model",
        cwd,
        env: { NOVA_MEMORY_DIR: join(home, ".nova-code", "memory") },
      });
      await writeFile(join(runtime.memoryDir, "a.md"), "---\nname: a\n---\nA");
      await writeFile(join(runtime.memoryDir, "b.md"), "---\nname: b\n---\nB");

      const first = await runtime.resolveRelevantMemories("q", SIGNAL);
      runtime.markSurfaced(first);

      const second = await runtime.resolveRelevantMemories("q", SIGNAL);
      // 第二次：a / b 都被 markSurfaced 标记，即使 LLM 仍然选了它们也会被过滤
      expect(second).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("extractorFactory 被调用一次（fire-and-forget）", async () => {
    const home = await freshCwd("novamem-rt-ext-home-");
    const cwd = await freshCwd("novamem-rt-ext-cwd-");
    try {
      let calls = 0;
      const runtime = await createMemoryRuntime({
        client: mockClient({}),
        model: "test-model",
        cwd,
        env: { NOVA_MEMORY_DIR: join(home, ".nova-code", "memory") },
        extractorFactoryBuilder: () => async () => {
          calls += 1;
        },
      });
      await runtime.runExtractorIfNeeded([]);
      expect(calls).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("extractorFactory 抛错不冒泡", async () => {
    const home = await freshCwd("novamem-rt-ext-throw-home-");
    const cwd = await freshCwd("novamem-rt-ext-throw-cwd-");
    try {
      const runtime = await createMemoryRuntime({
        client: mockClient({}),
        model: "test-model",
        cwd,
        env: { NOVA_MEMORY_DIR: join(home, ".nova-code", "memory") },
        extractorFactoryBuilder: () => async () => {
          throw new Error("boom");
        },
      });
      await expect(runtime.runExtractorIfNeeded([])).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("renderRelevantMemoriesAsSystemReminder", () => {
  test("空数组 → 空字符串", () => {
    expect(renderRelevantMemoriesAsSystemReminder([])).toBe("");
  });

  test("含 system-reminder 包装 + 多条以 --- 分隔", () => {
    const memories: SurfacedMemory[] = [
      { path: "/p/a.md", mtimeMs: Date.now(), content: "A body", header: "Memory: /p/a.md:" },
      { path: "/p/b.md", mtimeMs: Date.now(), content: "B body", header: "Memory: /p/b.md:" },
    ];
    const text = renderRelevantMemoriesAsSystemReminder(memories);
    expect(text).toStartWith("<system-reminder>");
    expect(text).toEndWith("</system-reminder>");
    expect(text).toContain("A body");
    expect(text).toContain("B body");
    expect(text).toContain("---");
  });
});
