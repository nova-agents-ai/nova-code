/**
 * LSTool 单测。从原 src/llm/tools.test.ts 拆出，行为不变，仅工具名 / 路径调整。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionError } from "../../errors/index.ts";
import { LSTool } from "./LSTool.ts";

const NOOP_SIGNAL = new AbortController().signal;

async function makeTempDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-code-lstool-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("LSTool", () => {
  test("name 字段为 'LS'（PascalCase 对齐 claude-code）", () => {
    expect(LSTool.name).toBe("LS");
  });

  test("列出空目录", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const result = await LSTool.execute({ path: dir }, { signal: NOOP_SIGNAL });
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
      const result = await LSTool.execute({ path: dir }, { signal: NOOP_SIGNAL });
      expect(result).toContain("file.txt");
      expect(result).toContain("subdir/");
    } finally {
      await cleanup();
    }
  });

  test("path 缺失时抛 ToolExecutionError", async () => {
    await expect(LSTool.execute({}, { signal: NOOP_SIGNAL })).rejects.toThrow(ToolExecutionError);
  });

  test("path 不是字符串时抛 ToolExecutionError", async () => {
    await expect(
      LSTool.execute({ path: 123 as unknown as string }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(ToolExecutionError);
  });

  test("不存在的目录抛 ToolExecutionError", async () => {
    await expect(
      LSTool.execute({ path: "/definitely/does/not/exist/anywhere" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/Failed to list directory/);
  });
});
