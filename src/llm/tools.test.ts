/**
 * 内置工具测试。验证 list_dir / read_file 在边界条件下的行为。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionError } from "./errors.ts";
import { builtinTools, findTool, listDirTool, readFileTool } from "./tools.ts";

const NOOP_SIGNAL = new AbortController().signal;

async function makeTempDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-code-tools-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("builtinTools 注册表", () => {
  test("包含 list_dir 和 read_file", () => {
    const names = builtinTools.map((t) => t.name);
    expect(names).toContain("list_dir");
    expect(names).toContain("read_file");
  });

  test("findTool 按名查找", () => {
    expect(findTool("list_dir", builtinTools)?.name).toBe("list_dir");
    expect(findTool("nonexistent", builtinTools)).toBeUndefined();
  });
});

describe("list_dir 工具", () => {
  test("列出空目录", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const result = await listDirTool.execute({ path: dir }, { signal: NOOP_SIGNAL });
      expect(result).toContain(`Directory: ${dir}`);
    } finally {
      await cleanup();
    }
  });

  test("列出包含文件和子目录的目录，子目录以 / 结尾", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      await writeFile(join(dir, "file.txt"), "hi");
      await mkdir(join(dir, "subdir"));
      const result = await listDirTool.execute({ path: dir }, { signal: NOOP_SIGNAL });
      expect(result).toContain("file.txt");
      expect(result).toContain("subdir/");
    } finally {
      await cleanup();
    }
  });

  test("path 缺失时抛 ToolExecutionError", async () => {
    await expect(listDirTool.execute({}, { signal: NOOP_SIGNAL })).rejects.toThrow(
      ToolExecutionError,
    );
  });

  test("path 不是字符串时抛 ToolExecutionError", async () => {
    await expect(
      listDirTool.execute({ path: 123 as unknown as string }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(ToolExecutionError);
  });

  test("不存在的目录抛 ToolExecutionError", async () => {
    await expect(
      listDirTool.execute({ path: "/definitely/does/not/exist/anywhere" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/Failed to list directory/);
  });
});

describe("read_file 工具", () => {
  test("读取小文本文件", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "hello.txt");
      await writeFile(filePath, "Hello, nova-code!");
      const result = await readFileTool.execute({ path: filePath }, { signal: NOOP_SIGNAL });
      expect(result).toBe("Hello, nova-code!");
    } finally {
      await cleanup();
    }
  });

  test("path 是目录时抛 ToolExecutionError", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      await expect(readFileTool.execute({ path: dir }, { signal: NOOP_SIGNAL })).rejects.toThrow(
        /not a regular file/,
      );
    } finally {
      await cleanup();
    }
  });

  test("不存在的文件抛 ToolExecutionError", async () => {
    await expect(
      readFileTool.execute({ path: "/definitely/does/not/exist.txt" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/Cannot stat/);
  });

  test("path 字段缺失时抛 ToolExecutionError", async () => {
    await expect(readFileTool.execute({}, { signal: NOOP_SIGNAL })).rejects.toThrow(
      /Missing required string field/,
    );
  });
});
