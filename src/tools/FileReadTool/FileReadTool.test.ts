/**
 * FileReadTool 单测。从原 src/llm/tools.test.ts 拆出，行为不变，仅工具名 / 路径调整。
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReadTool } from "./FileReadTool.ts";

const NOOP_SIGNAL = new AbortController().signal;

async function makeTempDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-code-filereadtool-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("FileReadTool", () => {
  test("name 字段为 'FileRead'（PascalCase 对齐 claude-code）", () => {
    expect(FileReadTool.name).toBe("FileRead");
  });

  test("读取小文本文件", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "hello.txt");
      await writeFile(filePath, "Hello, nova-code!");
      const result = await FileReadTool.execute({ path: filePath }, { signal: NOOP_SIGNAL });
      expect(result).toBe("Hello, nova-code!");
    } finally {
      await cleanup();
    }
  });

  test("path 是目录时抛 ToolExecutionError", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      await expect(FileReadTool.execute({ path: dir }, { signal: NOOP_SIGNAL })).rejects.toThrow(
        /not a regular file/,
      );
    } finally {
      await cleanup();
    }
  });

  test("不存在的文件抛 ToolExecutionError", async () => {
    await expect(
      FileReadTool.execute({ path: "/definitely/does/not/exist.txt" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/Cannot stat/);
  });

  test("path 字段缺失时抛 ToolExecutionError", async () => {
    await expect(FileReadTool.execute({}, { signal: NOOP_SIGNAL })).rejects.toThrow(
      /Missing required string field/,
    );
  });
});
