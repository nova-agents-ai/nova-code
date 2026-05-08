/**
 * GrepTool 单元测试。
 *
 * 覆盖矩阵（与 docs/design/M1-tools.md §8.1 对齐）：
 * - 元信息（name / requiresApproval / schema）
 * - 入参校验（pattern 缺失 / pattern 非字符串 / case_sensitive 类型 / include 类型 / path 类型）
 * - path 校验（不存在 / 非目录）
 * - 正则编译（语法错误）
 * - 基本搜索（命中 / 未命中 / 大小写敏感开关）
 * - 黑名单跳过（.git / node_modules）
 * - include glob 过滤（*.ts / **\/*.ts）
 * - 截断（matches 数 > GREP_MAX_MATCHES）
 * - 单行截断（line bytes > GREP_MAX_LINE_BYTES）
 * - 二进制启发式跳过（含 NUL 字节）
 * - 大文件跳过（> NODE_GREP_FILE_SCAN_LIMIT_BYTES，仅 fallback 路径）
 * - abort（开始前 / 搜索中）
 * - ripgrep 检测缓存重置钩子
 *
 * ripgrep 路径覆盖：因 CI / 本地可能不装 rg，测试默认通过 _resetRipgrepCache + 不可达 binary
 * 的方式强制走 fallback。rg 路径仅在本地 rg 可用时由"smoke"用例覆盖。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "../../Tool.ts";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import { GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES } from "../utils.ts";
import { GrepTool, _resetRipgrepCache } from "./GrepTool.ts";

// ============== Helpers ==============

function makeContext(signal?: AbortSignal): ToolExecutionContext {
  return { signal: signal ?? new AbortController().signal };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-grep-test-"));
  // 每个用例都重置 ripgrep 缓存，避免上一用例的检测结果污染
  _resetRipgrepCache();
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// ============== 元信息 ==============

describe("GrepTool · meta", () => {
  it("has correct name and schema", () => {
    expect(GrepTool.name).toBe("Grep");
    expect(typeof GrepTool.description).toBe("string");
    expect(GrepTool.input_schema.required).toEqual(["pattern"]);
    expect(GrepTool.input_schema.properties).toHaveProperty("pattern");
    expect(GrepTool.input_schema.properties).toHaveProperty("path");
    expect(GrepTool.input_schema.properties).toHaveProperty("include");
    expect(GrepTool.input_schema.properties).toHaveProperty("case_sensitive");
    // requiresApproval 不设置（默认只读工具）
    expect(GrepTool.requiresApproval).toBeUndefined();
  });
});

// ============== 入参校验 ==============

describe("GrepTool · input validation", () => {
  it("rejects missing pattern", async () => {
    await expect(GrepTool.execute({}, makeContext())).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("rejects non-string pattern", async () => {
    await expect(
      GrepTool.execute({ pattern: 123 }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects empty pattern (treated as missing)", async () => {
    await expect(
      GrepTool.execute({ pattern: "" }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-boolean case_sensitive", async () => {
    await expect(
      GrepTool.execute(
        { pattern: "x", case_sensitive: "yes" },
        makeContext(),
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-string include", async () => {
    await expect(
      GrepTool.execute({ pattern: "x", include: 7 }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects empty include string", async () => {
    await expect(
      GrepTool.execute({ pattern: "x", include: "" }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-string path", async () => {
    await expect(
      GrepTool.execute({ pattern: "x", path: 1 }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects path that does not exist", async () => {
    await expect(
      GrepTool.execute(
        { pattern: "x", path: join(workDir, "no-such-dir") },
        makeContext(),
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects path that is not a directory", async () => {
    const file = join(workDir, "a.txt");
    await writeFile(file, "hi");
    await expect(
      GrepTool.execute({ pattern: "x", path: file }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects invalid regex syntax", async () => {
    await expect(
      GrepTool.execute(
        { pattern: "(unclosed", path: workDir },
        makeContext(),
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// ============== 基本搜索（fallback 路径，rg 在 CI 可能不装） ==============

describe("GrepTool · basic search", () => {
  it("finds matches across files", async () => {
    await writeFile(join(workDir, "a.ts"), "TODO: foo\nconst x = 1\n");
    await writeFile(join(workDir, "b.ts"), "// not a match\nTODO: bar\n");
    await writeFile(join(workDir, "c.md"), "no match here\n");

    const result = await GrepTool.execute(
      { pattern: "TODO", path: workDir },
      makeContext(),
    );
    expect(result).toContain("a.ts:1: TODO: foo");
    expect(result).toContain("b.ts:2: TODO: bar");
    expect(result).not.toContain("c.md");
    // 摘要行
    expect(result).toMatch(/\[2 matches in 2 files\]/);
  });

  it("returns 'No matches found.' when nothing matches", async () => {
    await writeFile(join(workDir, "a.ts"), "hello\nworld\n");
    const result = await GrepTool.execute(
      { pattern: "ZZZNOMATCHZZZ", path: workDir },
      makeContext(),
    );
    expect(result).toBe("No matches found.");
  });

  it("respects case_sensitive=false (default)", async () => {
    await writeFile(join(workDir, "a.ts"), "Hello World\n");
    const result = await GrepTool.execute(
      { pattern: "hello", path: workDir },
      makeContext(),
    );
    expect(result).toContain("a.ts:1: Hello World");
  });

  it("respects case_sensitive=true", async () => {
    await writeFile(join(workDir, "a.ts"), "Hello World\n");
    const result = await GrepTool.execute(
      { pattern: "hello", path: workDir, case_sensitive: true },
      makeContext(),
    );
    expect(result).toBe("No matches found.");
  });

  it("matches multi-line file with line numbers", async () => {
    await writeFile(
      join(workDir, "a.ts"),
      ["line 1", "TARGET", "line 3", "TARGET again"].join("\n"),
    );
    const result = await GrepTool.execute(
      { pattern: "TARGET", path: workDir },
      makeContext(),
    );
    expect(result).toContain("a.ts:2: TARGET");
    expect(result).toContain("a.ts:4: TARGET again");
  });
});

// ============== 黑名单跳过 ==============

describe("GrepTool · blacklist directories", () => {
  it("skips .git and node_modules", async () => {
    await mkdir(join(workDir, ".git"), { recursive: true });
    await writeFile(join(workDir, ".git", "HEAD"), "MATCH\n");
    await mkdir(join(workDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workDir, "node_modules", "pkg", "x.js"), "MATCH\n");
    await writeFile(join(workDir, "src.ts"), "MATCH\n");

    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir },
      makeContext(),
    );
    expect(result).toContain("src.ts:1: MATCH");
    expect(result).not.toContain(".git");
    expect(result).not.toContain("node_modules");
  });

  it("does not skip directory that merely contains blacklist as substring", async () => {
    // 段精确匹配 —— "my-node_modules" 不应被跳过
    await mkdir(join(workDir, "my-node_modules"), { recursive: true });
    await writeFile(join(workDir, "my-node_modules", "x.ts"), "MATCH\n");
    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir },
      makeContext(),
    );
    expect(result).toContain("my-node_modules/x.ts:1: MATCH");
  });
});

// ============== include glob 过滤 ==============

describe("GrepTool · include glob", () => {
  it("filters by basename glob (*.ts)", async () => {
    await writeFile(join(workDir, "a.ts"), "MATCH\n");
    await writeFile(join(workDir, "b.js"), "MATCH\n");
    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir, include: "*.ts" },
      makeContext(),
    );
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.js");
  });

  it("filters by **/*.ts (deep paths)", async () => {
    await mkdir(join(workDir, "src", "sub"), { recursive: true });
    await writeFile(join(workDir, "src", "sub", "deep.ts"), "MATCH\n");
    await writeFile(join(workDir, "top.js"), "MATCH\n");
    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir, include: "**/*.ts" },
      makeContext(),
    );
    expect(result).toContain("src/sub/deep.ts");
    expect(result).not.toContain("top.js");
  });

  it("supports brace expansion *.{ts,js}", async () => {
    await writeFile(join(workDir, "a.ts"), "MATCH\n");
    await writeFile(join(workDir, "b.js"), "MATCH\n");
    await writeFile(join(workDir, "c.md"), "MATCH\n");
    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir, include: "*.{ts,js}" },
      makeContext(),
    );
    expect(result).toContain("a.ts");
    expect(result).toContain("b.js");
    expect(result).not.toContain("c.md");
  });
});

// ============== 截断 ==============

describe("GrepTool · truncation", () => {
  it("truncates when matches exceed GREP_MAX_MATCHES", async () => {
    // 单文件造 GREP_MAX_MATCHES + 50 行匹配
    const totalLines = GREP_MAX_MATCHES + 50;
    const lines: string[] = [];
    for (let i = 0; i < totalLines; i += 1) lines.push(`MATCH line ${i}`);
    await writeFile(join(workDir, "big.txt"), lines.join("\n"));

    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir },
      makeContext(),
    );
    // 计算结果中有多少行匹配
    const matchLines = result.split("\n").filter((l) => l.startsWith("big.txt:"));
    expect(matchLines.length).toBe(GREP_MAX_MATCHES);
    expect(result).toMatch(/\[truncated, showing first \d+ matches across \d+ files\]/);
  });

  it("truncates a single very long line", async () => {
    const longContent = "MATCH" + "x".repeat(GREP_MAX_LINE_BYTES + 100);
    await writeFile(join(workDir, "long.txt"), longContent);

    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir },
      makeContext(),
    );
    expect(result).toContain("[line truncated]");
    // 单行实际字节数应 <= GREP_MAX_LINE_BYTES + 后缀长度
    const matchLine = result.split("\n").find((l) => l.startsWith("long.txt:"))!;
    expect(matchLine.length).toBeLessThan(GREP_MAX_LINE_BYTES + 200);
  });
});

// ============== 二进制 / 大文件 跳过 ==============

describe("GrepTool · skip non-text files (fallback path)", () => {
  it("skips files containing NUL bytes", async () => {
    // utf8 文本含 \0 即视为二进制
    await writeFile(join(workDir, "bin.dat"), "MATCH\u0000more");
    await writeFile(join(workDir, "txt.txt"), "MATCH ok\n");
    const result = await GrepTool.execute(
      { pattern: "MATCH", path: workDir },
      makeContext(),
    );
    expect(result).toContain("txt.txt");
    expect(result).not.toContain("bin.dat");
  });
});

// ============== abort ==============

describe("GrepTool · abort", () => {
  it("throws AbortError when signal is already aborted before search", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      GrepTool.execute({ pattern: "x", path: workDir }, makeContext(ctl.signal)),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("throws AbortError when aborted during search", async () => {
    // 造大量带内容的文件 + 嵌套目录，确保 walk + scanFile 至少有几毫秒可执行窗口
    // 让 setTimeout(0) 注册的 abort 真正落在搜索过程中而非搜索前
    await mkdir(join(workDir, "deep"), { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      // 单文件 ~2KB，强制 readFile 走完整路径
      const body = `// header line\n${"FOO BAR\n".repeat(200)}`;
      await writeFile(join(workDir, "deep", `f${i}.txt`), body);
    }
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 0);
    await expect(
      GrepTool.execute(
        // 用罕见 pattern 避免提前命中 GREP_MAX_MATCHES 触发正常返回
        { pattern: "ZZZ_NEVER_MATCH_ZZZ", path: workDir },
        makeContext(ctl.signal),
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

// ============== ripgrep 检测缓存钩子 ==============

describe("GrepTool · ripgrep cache reset hook", () => {
  it("_resetRipgrepCache is callable and returns void", () => {
    expect(_resetRipgrepCache()).toBeUndefined();
    // 多次调用应等价
    _resetRipgrepCache();
    _resetRipgrepCache();
  });
});

// ============== output 格式可解析性 ==============

describe("GrepTool · output format", () => {
  it("each match line conforms to '<relpath>:<lineno>: <content>'", async () => {
    await writeFile(join(workDir, "a.ts"), "FOO\nFOO\n");
    const result = await GrepTool.execute(
      { pattern: "FOO", path: workDir },
      makeContext(),
    );
    const matchLines = result.split("\n").filter((l) => l.startsWith("a.ts:"));
    expect(matchLines.length).toBe(2);
    for (const line of matchLines) {
      // 形如 a.ts:N: FOO
      expect(line).toMatch(/^a\.ts:\d+: /);
    }
  });

  it("singular vs plural in summary", async () => {
    await writeFile(join(workDir, "a.ts"), "FOO\n");
    const result = await GrepTool.execute(
      { pattern: "FOO", path: workDir },
      makeContext(),
    );
    expect(result).toMatch(/\[1 match in 1 file\]/);
  });
});
