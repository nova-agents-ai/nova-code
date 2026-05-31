import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryLines, loadMemoryPrompt } from "./prompt.ts";

const FAKE_MEM_DIR = "/fake-home/.nova-code/memory/projects/-tmp-foo/";

describe("buildMemoryLines", () => {
  test("含标题 + 4 种 type", () => {
    const text = buildMemoryLines(FAKE_MEM_DIR).join("\n");
    expect(text).toContain("# auto memory");
    expect(text).toContain("<name>user</name>");
    expect(text).toContain("<name>feedback</name>");
    expect(text).toContain("<name>project</name>");
    expect(text).toContain("<name>reference</name>");
  });

  test("含 how-to-save 两步流程 + frontmatter 示例", () => {
    const text = buildMemoryLines(FAKE_MEM_DIR).join("\n");
    expect(text).toContain("## How to save memories");
    expect(text).toContain("**Step 1**");
    expect(text).toContain("**Step 2**");
    expect(text).toContain("type: {{user | feedback | project | reference}}");
  });

  test("含 when-to-access + drift caveat", () => {
    const text = buildMemoryLines(FAKE_MEM_DIR).join("\n");
    expect(text).toContain("## When to access memories");
    expect(text).toContain("Memory records can become stale");
  });

  test("含 verify-before-recommend + persistence 段", () => {
    const text = buildMemoryLines(FAKE_MEM_DIR).join("\n");
    expect(text).toContain("## Before recommending from memory");
    expect(text).toContain("## Memory and other forms of persistence");
  });

  test("memoryDir 出现在文案里", () => {
    const text = buildMemoryLines(FAKE_MEM_DIR).join("\n");
    expect(text).toContain(FAKE_MEM_DIR);
  });
});

describe("loadMemoryPrompt", () => {
  test("MEMORY.md 不存在 → 含 empty 降级文案", async () => {
    const text = await loadMemoryPrompt({
      memoryDir: FAKE_MEM_DIR,
      entrypointPath: "/nonexistent/__nova_no_mem_md__",
    });
    expect(text).toContain("## MEMORY.md");
    expect(text).toContain("currently empty");
  });

  test("MEMORY.md 存在 → 注入内容", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-prompt-"));
    try {
      const ep = join(dir, "MEMORY.md");
      await writeFile(ep, "- [User role](user_role.md) — Go expert\n");
      const text = await loadMemoryPrompt({
        memoryDir: FAKE_MEM_DIR,
        entrypointPath: ep,
      });
      expect(text).toContain("## MEMORY.md");
      expect(text).toContain("[User role](user_role.md)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("MEMORY.md 超 200 行 → 截断 + warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-prompt-trunc-"));
    try {
      const ep = join(dir, "MEMORY.md");
      const lines = Array.from({ length: 250 }, (_, i) => `- line ${i}`);
      await writeFile(ep, lines.join("\n"));
      const text = await loadMemoryPrompt({
        memoryDir: FAKE_MEM_DIR,
        entrypointPath: ep,
      });
      expect(text).toContain("WARNING: MEMORY.md is 250 lines");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
