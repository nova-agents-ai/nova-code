/**
 * FileWriteTool 单测。覆盖设计稿 §4.2 / §8.1 矩阵：
 *
 * - 正常创建（验证返回字符串格式 + 真实落盘内容 + bytes/lines 计数）
 * - 文件已存在拒绝（EEXIST → ToolExecutionError，提示用 FileEdit）
 * - 父目录自动 mkdir -p（嵌套多层）
 * - 超大内容拒绝（> WRITE_MAX_FILE_BYTES）
 * - abort 前检查（signal.aborted → AbortError）
 * - content 字段缺失 / 类型错误
 * - path 字段缺失
 * - 空文件创建（content = ""）
 * - lines 计数口径（空 / 单行无换行 / 单行有换行 / 多行）
 * - 错误消息路径脱敏（$HOME → ~）
 *
 * 与 BashTool.test.ts / FileReadTool.test.ts 风格一致：用 mkdtemp 临时目录，
 * finally 里 cleanup，互相隔离。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import { WRITE_MAX_FILE_BYTES } from "../utils.ts";
import { FileWriteTool } from "./FileWriteTool.ts";

const NOOP_SIGNAL = new AbortController().signal;

async function makeTempDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-code-filewritetool-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("FileWriteTool · 元信息", () => {
  test("name 字段为 'FileWrite'（PascalCase 对齐 claude-code）", () => {
    expect(FileWriteTool.name).toBe("FileWrite");
  });

  test("requiresApproval 为 true（写权工具，M3 审批 middleware 消费）", () => {
    expect(FileWriteTool.requiresApproval).toBe(true);
  });

  test("input_schema 必填字段为 path + content", () => {
    expect(FileWriteTool.input_schema.required).toEqual(["path", "content"]);
  });
});

describe("FileWriteTool · 正常路径", () => {
  test("创建新文件并落盘", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "hello.txt");
      const content = "Hello, nova-code!\nLine 2\n";
      const result = await FileWriteTool.execute(
        { path: filePath, content },
        { signal: NOOP_SIGNAL },
      );

      // 返回字符串格式：Created <path> (<N> bytes, <M> lines)
      expect(result).toMatch(/^Created .+hello\.txt \(\d+ bytes, \d+ lines\)$/);

      // 真实落盘
      const written = await readFile(filePath, "utf8");
      expect(written).toBe(content);
    } finally {
      await cleanup();
    }
  });

  test("父目录不存在时自动 mkdir -p", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "a", "b", "c", "deep.txt");
      const result = await FileWriteTool.execute(
        { path: filePath, content: "deep" },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toContain("Created");
      const written = await readFile(filePath, "utf8");
      expect(written).toBe("deep");
    } finally {
      await cleanup();
    }
  });

  test("创建空文件（content = ''）合法", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "empty.txt");
      const result = await FileWriteTool.execute(
        { path: filePath, content: "" },
        { signal: NOOP_SIGNAL },
      );
      // 0 bytes, 0 lines
      expect(result).toMatch(/\(0 bytes, 0 lines\)$/);
      const written = await readFile(filePath, "utf8");
      expect(written).toBe("");
    } finally {
      await cleanup();
    }
  });

  test("相对路径相对 process.cwd() 解析", async () => {
    const { dir, cleanup } = await makeTempDir();
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      const result = await FileWriteTool.execute(
        { path: "rel.txt", content: "rel" },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toContain("Created");
      const written = await readFile(join(dir, "rel.txt"), "utf8");
      expect(written).toBe("rel");
    } finally {
      process.chdir(originalCwd);
      await cleanup();
    }
  });
});

describe("FileWriteTool · 行数统计口径", () => {
  test("空字符串 → 0 行", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const result = await FileWriteTool.execute(
        { path: join(dir, "f.txt"), content: "" },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toMatch(/0 lines/);
    } finally {
      await cleanup();
    }
  });

  test("单行无尾换行 'abc' → 1 行", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const result = await FileWriteTool.execute(
        { path: join(dir, "f.txt"), content: "abc" },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toMatch(/1 lines/);
    } finally {
      await cleanup();
    }
  });

  test("单行有尾换行 'abc\\n' → 2 行（split('\\n') 口径）", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const result = await FileWriteTool.execute(
        { path: join(dir, "f.txt"), content: "abc\n" },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toMatch(/2 lines/);
    } finally {
      await cleanup();
    }
  });

  test("多行 'a\\nb\\nc' → 3 行", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const result = await FileWriteTool.execute(
        { path: join(dir, "f.txt"), content: "a\nb\nc" },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toMatch(/3 lines/);
    } finally {
      await cleanup();
    }
  });
});

describe("FileWriteTool · 错误处理", () => {
  test("文件已存在 → 抛 ToolExecutionError 并提示用 FileEdit", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "exists.txt");
      await writeFile(filePath, "old");

      await expect(
        FileWriteTool.execute({ path: filePath, content: "new" }, { signal: NOOP_SIGNAL }),
      ).rejects.toThrow(/already exists.*FileEdit/);

      // 原文件内容未被覆盖
      const stillOld = await readFile(filePath, "utf8");
      expect(stillOld).toBe("old");
    } finally {
      await cleanup();
    }
  });

  test("content 超过 WRITE_MAX_FILE_BYTES → 拒绝", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "huge.txt");
      // 5MB + 1 字节
      const huge = "a".repeat(WRITE_MAX_FILE_BYTES + 1);
      await expect(
        FileWriteTool.execute({ path: filePath, content: huge }, { signal: NOOP_SIGNAL }),
      ).rejects.toThrow(/Content too large/);

      // 文件未被创建
      await expect(readFile(filePath, "utf8")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("path 字段缺失 → ToolExecutionError", async () => {
    await expect(FileWriteTool.execute({ content: "x" }, { signal: NOOP_SIGNAL })).rejects.toThrow(
      /Missing required string field 'path'/,
    );
  });

  test("content 字段缺失 → ToolExecutionError", async () => {
    await expect(
      FileWriteTool.execute({ path: "/tmp/x" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/Missing required string field 'content'/);
  });

  test("content 非字符串 → ToolExecutionError", async () => {
    await expect(
      FileWriteTool.execute({ path: "/tmp/x", content: 123 }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/Missing required string field 'content'/);
  });

  test("已 abort 的 signal → AbortError，不落盘", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const filePath = join(dir, "aborted.txt");
      const controller = new AbortController();
      controller.abort();

      await expect(
        FileWriteTool.execute({ path: filePath, content: "x" }, { signal: controller.signal }),
      ).rejects.toThrow(AbortError);

      await expect(readFile(filePath, "utf8")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe("FileWriteTool · 路径脱敏", () => {
  let homeTempDir: string | null = null;
  let previousHome: string | undefined;

  beforeAll(async () => {
    previousHome = process.env["HOME"];
    homeTempDir = await mkdtemp(join(tmpdir(), "nova-code-filewritetool-home-"));
    process.env["HOME"] = homeTempDir;
  });

  afterAll(async () => {
    if (homeTempDir) {
      await rm(homeTempDir, { recursive: true, force: true });
    }
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
  });

  test("已存在文件的错误消息把 $HOME 替换为 ~", async () => {
    if (homeTempDir === null) throw new Error("homeTempDir not set up");
    const tempHome = homeTempDir;
    const filePath = join(tempHome, "existed.txt");
    await writeFile(filePath, "old");

    let caught: unknown;
    try {
      await FileWriteTool.execute({ path: filePath, content: "new" }, { signal: NOOP_SIGNAL });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).not.toContain(tempHome);
    expect(message).toContain("~/existed.txt");
  });
});
