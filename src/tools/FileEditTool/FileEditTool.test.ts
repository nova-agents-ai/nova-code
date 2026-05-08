/**
 * FileEditTool 单测。覆盖设计稿 §4.3 / §8.1 矩阵：
 *
 * 元信息：name / requiresApproval / input_schema
 *
 * 前置校验（不读文件、不写）：
 * - path 缺失 / old_string 缺失 / new_string 缺失
 * - replace_all 非 boolean
 * - no-op edit (old_string === new_string，含 replace_all=true 也拒绝)
 * - 文件不存在
 * - path 是目录
 * - 文件超过 EDIT_MAX_FILE_BYTES
 *
 * 主流程：
 * - 单次替换：行内 partial / 单行整行 / 跨多行 / 删除整行 / 文件首行 / 文件末行（无尾换行） / 整文件被替换为空
 * - replace_all：多次匹配全替换 / hunk 截断（>3 个）
 * - 多次匹配但 replace_all=false → 抛错
 * - 0 次匹配 → 抛错（含文件统计信息）
 *
 * 输出格式：
 * - "Edited <path>" 头部
 * - "Replacements: N" 计数
 * - "Lines before: X → after: Y" 行数（覆盖空文件 / 单行无换行 / 单行有换行 / 多行）
 * - Diff 段含 "@@ line L @@" / context 空格前缀 / "-" 删除 / "+" 新增
 * - replace_all 多匹配头部为 "Diff (first N hunks):" + "... (M more hunks omitted)" 截断
 *
 * 原子写：
 * - 写入完成后无残留 .tmp 文件
 * - rename 失败模拟（path 在写入瞬间被改为只读父目录）— 跨平台不稳定，跳过
 *
 * 安全：
 * - abort signal → AbortError 且文件未改
 *
 * 路径脱敏：
 * - 错误消息把 $HOME 替换为 ~
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import { EDIT_MAX_FILE_BYTES } from "../utils.ts";
import { FileEditTool } from "./FileEditTool.ts";

const NOOP_SIGNAL = new AbortController().signal;

async function makeTempDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-code-fileedittool-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function setupFile(content: string): Promise<{
  path: string;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const { dir, cleanup } = await makeTempDir();
  const path = join(dir, "f.txt");
  await writeFile(path, content);
  return { path, dir, cleanup };
}

// ============================================================
describe("FileEditTool · 元信息", () => {
  test("name 字段为 'FileEdit'（PascalCase）", () => {
    expect(FileEditTool.name).toBe("FileEdit");
  });

  test("requiresApproval 为 true（写权工具）", () => {
    expect(FileEditTool.requiresApproval).toBe(true);
  });

  test("input_schema 必填字段为 path + old_string + new_string", () => {
    expect(FileEditTool.input_schema.required).toEqual([
      "path",
      "old_string",
      "new_string",
    ]);
  });
});

// ============================================================
describe("FileEditTool · 前置校验", () => {
  test("path 字段缺失 → ToolExecutionError", async () => {
    await expect(
      FileEditTool.execute(
        { old_string: "a", new_string: "b" },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/Missing required string field 'path'/);
  });

  test("old_string 字段缺失 → ToolExecutionError", async () => {
    await expect(
      FileEditTool.execute(
        { path: "/tmp/x", new_string: "b" },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/Missing required string field 'old_string'/);
  });

  test("new_string 字段缺失 → ToolExecutionError", async () => {
    await expect(
      FileEditTool.execute(
        { path: "/tmp/x", old_string: "a" },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/Missing required string field 'new_string'/);
  });

  test("replace_all 非 boolean → ToolExecutionError", async () => {
    await expect(
      FileEditTool.execute(
        { path: "/tmp/x", old_string: "a", new_string: "b", replace_all: "yes" },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/'replace_all' must be a boolean/);
  });

  test("no-op edit（old_string === new_string）→ 拒绝", async () => {
    await expect(
      FileEditTool.execute(
        { path: "/tmp/x", old_string: "abc", new_string: "abc" },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/no-op edit/);
  });

  test("no-op edit 即使 replace_all=true 也拒绝", async () => {
    await expect(
      FileEditTool.execute(
        { path: "/tmp/x", old_string: "abc", new_string: "abc", replace_all: true },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/no-op edit/);
  });

  test("文件不存在 → 抛错并建议用 FileWrite", async () => {
    await expect(
      FileEditTool.execute(
        { path: "/definitely/does/not/exist.txt", old_string: "a", new_string: "b" },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(/file not found.*FileWrite/);
  });

  test("path 是目录 → 抛错", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      await expect(
        FileEditTool.execute(
          { path: dir, old_string: "a", new_string: "b" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/not a regular file/);
    } finally {
      await cleanup();
    }
  });

  test("文件超过 EDIT_MAX_FILE_BYTES → 拒绝", async () => {
    const { path, cleanup } = await setupFile("a".repeat(EDIT_MAX_FILE_BYTES + 1));
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "a", new_string: "b" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/file too large to edit/);
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
describe("FileEditTool · 主流程 / 单次替换", () => {
  test("行内 partial 替换：'foo bar baz' 中 bar→qux", async () => {
    const { path, cleanup } = await setupFile("foo bar baz\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "bar", new_string: "qux" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("foo qux baz\n");
      expect(result).toContain("Replacements: 1");
      expect(result).toContain("- foo bar baz");
      expect(result).toContain("+ foo qux baz");
    } finally {
      await cleanup();
    }
  });

  test("文件首行替换", async () => {
    const { path, cleanup } = await setupFile("first\nsecond\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "first", new_string: "FIRST" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("FIRST\nsecond\n");
      expect(result).toMatch(/@@ line 1 @@/);
      expect(result).toContain("- first");
      expect(result).toContain("+ FIRST");
      // afterContext 应该有 second
      expect(result).toContain("    second");
    } finally {
      await cleanup();
    }
  });

  test("文件末行替换（无尾换行）", async () => {
    const { path, cleanup } = await setupFile("a\nb\nc");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "c", new_string: "C" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("a\nb\nC");
      expect(result).toContain("- c");
      expect(result).toContain("+ C");
      // beforeContext 应该有 a / b
      expect(result).toContain("    a");
      expect(result).toContain("    b");
    } finally {
      await cleanup();
    }
  });

  test("跨多行替换为单行：'abc\\ndef' → 'X'", async () => {
    const { path, cleanup } = await setupFile("ctx0\nabc\ndef\nctx1\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "abc\ndef", new_string: "X" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("ctx0\nX\nctx1\n");
      expect(result).toContain("- abc");
      expect(result).toContain("- def");
      expect(result).toContain("+ X");
      expect(result).toContain("    ctx0"); // before context
      expect(result).toContain("    ctx1"); // after context
    } finally {
      await cleanup();
    }
  });

  test("跨多行替换为多行（行数增加）", async () => {
    const { path, cleanup } = await setupFile("ctx0\nold1\nold2\nctx1\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "old1\nold2", new_string: "new1\nnew2\nnew3" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("ctx0\nnew1\nnew2\nnew3\nctx1\n");
      expect(result).toContain("Lines before: 4 → after: 5");
      expect(result).toContain("- old1");
      expect(result).toContain("- old2");
      expect(result).toContain("+ new1");
      expect(result).toContain("+ new2");
      expect(result).toContain("+ new3");
    } finally {
      await cleanup();
    }
  });

  test("整行删除（oldString 含尾换行）：不应展示误导性 '+ <空>' 行", async () => {
    const { path, cleanup } = await setupFile("line1\nline2\nline3\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "line2\n", new_string: "" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("line1\nline3\n");
      expect(result).toContain("- line2");
      // 关键断言：不应有 "+ <空>" 这种误导行（修复 buildHunks 的边界 bug）
      const lines = result.split("\n");
      const plusLines = lines.filter((l) => l.startsWith("  + "));
      expect(plusLines).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("整文件被替换为空：addedLines 为空，不展示 '+ <空>'", async () => {
    const { path, cleanup } = await setupFile("hello");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "hello", new_string: "" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("");
      expect(result).toContain("Lines before: 1 → after: 0");
      expect(result).toContain("- hello");
      const plusLines = result.split("\n").filter((l) => l.startsWith("  + "));
      expect(plusLines).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
describe("FileEditTool · replace_all", () => {
  test("多次匹配但 replace_all=false → 抛错", async () => {
    const { path, cleanup } = await setupFile("foo\nfoo\nfoo\n");
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "foo", new_string: "bar" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/found 3 times.*replace_all=true/);
    } finally {
      await cleanup();
    }
  });

  test("0 次匹配 → 抛错并附文件统计", async () => {
    const { path, cleanup } = await setupFile("hello\nworld\n");
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "missing", new_string: "x" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/old_string not found.*has 2 lines and 12 bytes/);
    } finally {
      await cleanup();
    }
  });

  test("replace_all=true 全部替换", async () => {
    const { path, cleanup } = await setupFile("foo\nfoo\nfoo\n");
    try {
      const result = await FileEditTool.execute(
        {
          path,
          old_string: "foo",
          new_string: "bar",
          replace_all: true,
        },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("bar\nbar\nbar\n");
      expect(result).toContain("Replacements: 3");
    } finally {
      await cleanup();
    }
  });

  // hunk 截断逻辑测试：每个匹配相隔 ≥ CONTEXT_LINES*2+1=5 行确保产生独立 hunk
  // （相邻匹配会被 buildHunks 合并到同一 hunk）
  test("replace_all 命中 > 3 个不连续位置时只展示前 3 hunk + omitted 提示", async () => {
    // 5 个 TODO 各独占一段，相隔 5 行（远超 context 重叠范围），保证 5 个独立 hunk
    const sep = "\n.\n.\n.\n.\n.\n"; // 5 行无关内容做分隔
    const content =
      "TODO 1" + sep + "TODO 2" + sep + "TODO 3" + sep + "TODO 4" + sep + "TODO 5\n";
    const { path, cleanup } = await setupFile(content);
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "TODO", new_string: "DONE", replace_all: true },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toContain("Replacements: 5");
      expect(result).toMatch(/Diff \(first 3 hunks\):/);
      expect(result).toMatch(/\(2 more hunks omitted\)/);
      const headers = result.match(/@@ line \d+ @@/g) ?? [];
      expect(headers.length).toBe(3);
    } finally {
      await cleanup();
    }
  });

  test("replace_all 命中正好 = 3 个独立 hunk 不展示 omitted 提示", async () => {
    // 3 个 x 各相隔 5 行确保不被合并
    const content = "x\n.\n.\n.\n.\n.\nx\n.\n.\n.\n.\n.\nx\n";
    const { path, cleanup } = await setupFile(content);
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "x", new_string: "y", replace_all: true },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toContain("Replacements: 3");
      expect(result).toMatch(/Diff \(first 3 hunks\):/);
      expect(result).not.toMatch(/more hunks omitted/);
      const headers = result.match(/@@ line \d+ @@/g) ?? [];
      expect(headers.length).toBe(3);
    } finally {
      await cleanup();
    }
  });

  test("replace_all 多个匹配位于同一行 → 合并为单 hunk（不互相矛盾）", async () => {
    const { path, cleanup } = await setupFile("foo foo foo\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "foo", new_string: "BAR", replace_all: true },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("BAR BAR BAR\n");
      expect(result).toContain("Replacements: 3");
      // 关键断言：只有一个 hunk，且 added 行展示真实最终结果（不是单替换模拟）
      const headers = result.match(/@@ line \d+ @@/g) ?? [];
      expect(headers.length).toBe(1);
      expect(result).toContain("- foo foo foo");
      expect(result).toContain("+ BAR BAR BAR");
      // 没有任何 "+ BAR foo foo" 这种基于"假设单替换"的错误展示
      expect(result).not.toContain("+ BAR foo foo");
      expect(result).not.toContain("+ foo BAR foo");
    } finally {
      await cleanup();
    }
  });

  test("replace_all 相邻行匹配 → 合并为单 hunk", async () => {
    const { path, cleanup } = await setupFile("foo\nfoo\nbar\n");
    try {
      const result = await FileEditTool.execute(
        { path, old_string: "foo", new_string: "X", replace_all: true },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(path, "utf8")).toBe("X\nX\nbar\n");
      expect(result).toContain("Replacements: 2");
      const headers = result.match(/@@ line \d+ @@/g) ?? [];
      expect(headers.length).toBe(1);
      // 两行都被替换，应在同一 hunk 内连续显示
      const removedLines = result.split("\n").filter((l) => l.startsWith("  - "));
      const addedLines = result.split("\n").filter((l) => l.startsWith("  + "));
      expect(removedLines).toEqual(["  - foo", "  - foo"]);
      expect(addedLines).toEqual(["  + X", "  + X"]);
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
describe("FileEditTool · 行数统计口径", () => {
  test("空文件 → 0 行", async () => {
    // 空文件无法触发替换（无 old_string 可匹配），间接验证 countLines 通过 0 匹配错误
    const { path, cleanup } = await setupFile("");
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "x", new_string: "y" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/has 0 lines and 0 bytes/);
    } finally {
      await cleanup();
    }
  });

  test("单行无尾换行 'abc' → 1 行", async () => {
    const { path, cleanup } = await setupFile("abc");
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "missing", new_string: "y" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/has 1 lines and 3 bytes/);
    } finally {
      await cleanup();
    }
  });

  test("单行有尾换行 'abc\\n' → 1 行（与 wc -l 一致）", async () => {
    const { path, cleanup } = await setupFile("abc\n");
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "missing", new_string: "y" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/has 1 lines and 4 bytes/);
    } finally {
      await cleanup();
    }
  });

  test("多行混合 'a\\nb\\nc' → 3 行（无尾换行）", async () => {
    const { path, cleanup } = await setupFile("a\nb\nc");
    try {
      await expect(
        FileEditTool.execute(
          { path, old_string: "missing", new_string: "y" },
          { signal: NOOP_SIGNAL },
        ),
      ).rejects.toThrow(/has 3 lines and 5 bytes/);
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
describe("FileEditTool · 原子写", () => {
  test("成功写入后无残留 .tmp 文件", async () => {
    const { path, dir, cleanup } = await setupFile("foo");
    try {
      await FileEditTool.execute(
        { path, old_string: "foo", new_string: "bar" },
        { signal: NOOP_SIGNAL },
      );
      const entries = await readdir(dir);
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
      expect(tmpFiles).toEqual([]);
      // 实际目标文件已更新
      expect(await readFile(path, "utf8")).toBe("bar");
    } finally {
      await cleanup();
    }
  });

  test("相对路径相对 process.cwd() 解析", async () => {
    const { dir, cleanup } = await makeTempDir();
    const originalCwd = process.cwd();
    try {
      const filePath = join(dir, "rel.txt");
      await writeFile(filePath, "old");
      process.chdir(dir);
      await FileEditTool.execute(
        { path: "rel.txt", old_string: "old", new_string: "new" },
        { signal: NOOP_SIGNAL },
      );
      expect(await readFile(filePath, "utf8")).toBe("new");
    } finally {
      process.chdir(originalCwd);
      await cleanup();
    }
  });
});

// ============================================================
describe("FileEditTool · abort", () => {
  test("已 abort 的 signal → AbortError，文件未改", async () => {
    const { path, cleanup } = await setupFile("foo");
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        FileEditTool.execute(
          { path, old_string: "foo", new_string: "bar" },
          { signal: controller.signal },
        ),
      ).rejects.toThrow(AbortError);
      // 文件内容未改
      expect(await readFile(path, "utf8")).toBe("foo");
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
describe("FileEditTool · 路径脱敏", () => {
  let homeTempDir: string | null = null;

  beforeAll(async () => {
    homeTempDir = await mkdtemp(join(homedir(), ".nova-code-fileedittool-test-"));
  });

  afterAll(async () => {
    if (homeTempDir) await rm(homeTempDir, { recursive: true, force: true });
  });

  test("文件不存在的错误消息把 $HOME 替换为 ~", async () => {
    if (!homeTempDir) throw new Error("homeTempDir not set up");
    const missing = join(homeTempDir, "missing.txt");

    let caught: unknown;
    try {
      await FileEditTool.execute(
        { path: missing, old_string: "a", new_string: "b" },
        { signal: NOOP_SIGNAL },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).not.toContain(homedir());
    expect(message).toMatch(/~\/\.nova-code-fileedittool-test-/);
  });

  test("正常输出（Edited <path>）也走脱敏", async () => {
    if (!homeTempDir) throw new Error("homeTempDir not set up");
    const filePath = join(homeTempDir, "edit-me.txt");
    await writeFile(filePath, "old");

    const result = await FileEditTool.execute(
      { path: filePath, old_string: "old", new_string: "new" },
      { signal: NOOP_SIGNAL },
    );
    expect(result).not.toContain(homedir());
    expect(result).toMatch(/Edited ~\/\.nova-code-fileedittool-test-/);
  });
});
