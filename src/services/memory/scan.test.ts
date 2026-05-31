import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMemoryManifest, scanMemoryFiles } from "./scan.ts";

const SIGNAL = new AbortController().signal;

async function writeMemoryFile(
  dir: string,
  relPath: string,
  content: string,
  mtime?: Date,
): Promise<void> {
  const filePath = join(dir, relPath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content);
  if (mtime !== undefined) {
    await utimes(filePath, mtime, mtime);
  }
}

describe("scanMemoryFiles", () => {
  test("空目录返回空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-scan-empty-"));
    try {
      const result = await scanMemoryFiles(dir, SIGNAL);
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("不存在目录返回空（不抛）", async () => {
    const result = await scanMemoryFiles("/nonexistent/__nova_mem_dir__", SIGNAL);
    expect(result).toEqual([]);
  });

  test("剔除 MEMORY.md 索引", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-scan-skipidx-"));
    try {
      await writeMemoryFile(dir, "MEMORY.md", "- foo");
      await writeMemoryFile(dir, "foo.md", "---\nname: foo\n---\nbody");
      const result = await scanMemoryFiles(dir, SIGNAL);
      expect(result.map((m) => m.filename)).toEqual(["foo.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("递归扫子目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-scan-recur-"));
    try {
      await writeMemoryFile(dir, "top.md", "---\nname: a\n---\n");
      await writeMemoryFile(dir, "team/inner.md", "---\nname: b\n---\n");
      const result = await scanMemoryFiles(dir, SIGNAL);
      const names = result.map((m) => m.filename).sort();
      expect(names).toEqual(["team/inner.md", "top.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("解析 frontmatter 的 description 与 type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-scan-fm-"));
    try {
      await writeMemoryFile(
        dir,
        "feedback.md",
        "---\nname: f\ndescription: hello desc\ntype: feedback\n---\nbody",
      );
      const result = await scanMemoryFiles(dir, SIGNAL);
      expect(result).toHaveLength(1);
      const header = result[0];
      expect(header?.description).toBe("hello desc");
      expect(header?.type).toBe("feedback");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("无效 type → undefined（不抛）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-scan-badtype-"));
    try {
      await writeMemoryFile(dir, "x.md", "---\nname: x\ntype: bogus\n---\n");
      const result = await scanMemoryFiles(dir, SIGNAL);
      expect(result[0]?.type).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("按 mtime 倒序", async () => {
    const dir = await mkdtemp(join(tmpdir(), "novamem-scan-sort-"));
    try {
      const oldMtime = new Date(Date.now() - 1_000_000);
      const newMtime = new Date(Date.now() - 1_000);
      await writeMemoryFile(dir, "old.md", "---\nname: old\n---\n", oldMtime);
      await writeMemoryFile(dir, "new.md", "---\nname: new\n---\n", newMtime);
      const result = await scanMemoryFiles(dir, SIGNAL);
      expect(result.map((m) => m.filename)).toEqual(["new.md", "old.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatMemoryManifest", () => {
  test("含 type / description 完整渲染", () => {
    const out = formatMemoryManifest([
      {
        filename: "a.md",
        filePath: "/m/a.md",
        mtimeMs: Date.parse("2026-05-25T00:00:00Z"),
        description: "user is a Go expert",
        type: "user",
      },
    ]);
    expect(out).toContain("[user] a.md");
    expect(out).toContain("(2026-05-25T00:00:00.000Z)");
    expect(out).toContain(": user is a Go expert");
  });

  test("缺 type 不带方括号", () => {
    const out = formatMemoryManifest([
      {
        filename: "x.md",
        filePath: "/m/x.md",
        mtimeMs: Date.parse("2026-05-25T00:00:00Z"),
        description: null,
        type: undefined,
      },
    ]);
    expect(out).toContain("- x.md (");
    expect(out).not.toContain("[");
  });
});
