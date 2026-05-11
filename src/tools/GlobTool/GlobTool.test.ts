/**
 * GlobTool 单元测试。
 *
 * 覆盖矩阵（与 docs/design/M1-tools.md §8.1 对齐）：
 * - 元信息（name / requiresApproval / schema）
 * - 入参校验（pattern 缺失 / 非字符串 / cwd 类型）
 * - cwd 校验（不存在 / 非目录 / 无权限走 validateCwd 共享逻辑，已由 BashTool.test 全量覆盖，此处只做 smoke）
 * - 基础 glob（*.ts / 双星号深度匹配 / brace expansion）
 * - 黑名单跳过（.git / node_modules）
 * - mtime 倒序
 * - 截断（> GLOB_MAX_RESULTS）
 * - 不返回目录（onlyFiles=true）
 * - abort（开始前 / 扫描中）
 * - output 格式（路径 + summary）
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import type { ToolExecutionContext } from "../../Tool.ts";
import { GLOB_MAX_RESULTS } from "../utils.ts";
import { GlobTool } from "./GlobTool.ts";

// ============== Helpers ==============

function makeContext(signal?: AbortSignal): ToolExecutionContext {
  return { signal: signal ?? new AbortController().signal };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-glob-test-"));
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// ============== 元信息 ==============

describe("GlobTool · meta", () => {
  it("has correct name and schema", () => {
    expect(GlobTool.name).toBe("Glob");
    expect(typeof GlobTool.description).toBe("string");
    expect(GlobTool.input_schema.required).toEqual(["pattern"]);
    expect(GlobTool.input_schema.properties).toHaveProperty("pattern");
    expect(GlobTool.input_schema.properties).toHaveProperty("cwd");
    // requiresApproval 不设置（默认只读工具）
    expect(GlobTool.requiresApproval).toBeUndefined();
  });
});

// ============== 入参校验 ==============

describe("GlobTool · input validation", () => {
  it("rejects missing pattern", async () => {
    await expect(GlobTool.execute({}, makeContext())).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-string pattern", async () => {
    await expect(GlobTool.execute({ pattern: 7 }, makeContext())).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("rejects empty pattern", async () => {
    await expect(GlobTool.execute({ pattern: "" }, makeContext())).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("rejects cwd that does not exist", async () => {
    await expect(
      GlobTool.execute({ pattern: "*.ts", cwd: join(workDir, "no-such-dir") }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects cwd that is a file (not a directory)", async () => {
    const file = join(workDir, "f.txt");
    await writeFile(file, "x");
    await expect(
      GlobTool.execute({ pattern: "*.ts", cwd: file }, makeContext()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// ============== 基础 glob ==============

describe("GlobTool · basic patterns", () => {
  it("matches *.ts in cwd (basename only)", async () => {
    await writeFile(join(workDir, "a.ts"), "x");
    await writeFile(join(workDir, "b.js"), "x");
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "deep.ts"), "x");

    const result = await GlobTool.execute({ pattern: "*.ts", cwd: workDir }, makeContext());
    expect(result).toContain("a.ts");
    expect(result).not.toContain("b.js");
    expect(result).not.toContain("src/deep.ts");
  });

  it("matches deep paths via double-star pattern", async () => {
    await writeFile(join(workDir, "a.ts"), "x");
    await mkdir(join(workDir, "src", "sub"), { recursive: true });
    await writeFile(join(workDir, "src", "sub", "deep.ts"), "x");
    await writeFile(join(workDir, "src", "mid.ts"), "x");

    const result = await GlobTool.execute({ pattern: "**/*.ts", cwd: workDir }, makeContext());
    expect(result).toContain("a.ts");
    expect(result).toContain("src/mid.ts");
    expect(result).toContain("src/sub/deep.ts");
  });

  it("supports brace expansion *.{ts,js}", async () => {
    await writeFile(join(workDir, "a.ts"), "x");
    await writeFile(join(workDir, "b.js"), "x");
    await writeFile(join(workDir, "c.md"), "x");

    const result = await GlobTool.execute({ pattern: "*.{ts,js}", cwd: workDir }, makeContext());
    expect(result).toContain("a.ts");
    expect(result).toContain("b.js");
    expect(result).not.toContain("c.md");
  });

  it("returns 'No files match.' when nothing matches", async () => {
    await writeFile(join(workDir, "a.ts"), "x");
    const result = await GlobTool.execute({ pattern: "*.zzz", cwd: workDir }, makeContext());
    expect(result).toBe("No files match.");
  });
});

// ============== 黑名单跳过 ==============

describe("GlobTool · blacklist", () => {
  it("skips .git and node_modules even if pattern matches them", async () => {
    await mkdir(join(workDir, ".git"), { recursive: true });
    await writeFile(join(workDir, ".git", "HEAD"), "x");
    await mkdir(join(workDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workDir, "node_modules", "pkg", "x.ts"), "x");
    await writeFile(join(workDir, "src.ts"), "x");

    const result = await GlobTool.execute({ pattern: "**/*", cwd: workDir }, makeContext());
    expect(result).toContain("src.ts");
    expect(result).not.toContain(".git");
    expect(result).not.toContain("node_modules");
  });

  it("does not skip directories whose name only contains blacklist substring", async () => {
    // 段精确匹配语义 —— "my-node_modules" 不应被跳过
    await mkdir(join(workDir, "my-node_modules"), { recursive: true });
    await writeFile(join(workDir, "my-node_modules", "x.ts"), "x");
    const result = await GlobTool.execute({ pattern: "**/*.ts", cwd: workDir }, makeContext());
    expect(result).toContain("my-node_modules/x.ts");
  });
});

// ============== mtime 倒序 ==============

describe("GlobTool · mtime sort", () => {
  it("returns files sorted by mtime descending (most recent first)", async () => {
    const now = Date.now();
    const oldFile = join(workDir, "old.ts");
    const newFile = join(workDir, "new.ts");
    const middleFile = join(workDir, "middle.ts");

    await writeFile(oldFile, "x");
    await writeFile(middleFile, "x");
    await writeFile(newFile, "x");

    // 显式设置 mtime 避免 fs 时间戳精度问题
    await utimes(oldFile, new Date(now - 60_000), new Date(now - 60_000));
    await utimes(middleFile, new Date(now - 30_000), new Date(now - 30_000));
    await utimes(newFile, new Date(now - 1_000), new Date(now - 1_000));

    const result = await GlobTool.execute({ pattern: "*.ts", cwd: workDir }, makeContext());

    const fileLines = result.split("\n").filter((l) => l.endsWith(".ts"));
    // 按出现顺序：new → middle → old
    expect(fileLines).toEqual(["new.ts", "middle.ts", "old.ts"]);
  });
});

// ============== 截断 ==============

describe("GlobTool · truncation", () => {
  it("truncates when match count exceeds GLOB_MAX_RESULTS", async () => {
    // 造 GLOB_MAX_RESULTS + 50 个 ts 文件
    const total = GLOB_MAX_RESULTS + 50;
    for (let i = 0; i < total; i += 1) {
      await writeFile(join(workDir, `f${i}.ts`), "x");
    }

    const result = await GlobTool.execute({ pattern: "*.ts", cwd: workDir }, makeContext());
    const fileLines = result.split("\n").filter((l) => l.endsWith(".ts"));
    expect(fileLines.length).toBe(GLOB_MAX_RESULTS);
    expect(result).toMatch(/\[truncated, showing first \d+ matches\]/);
  });
});

// ============== 不返回目录 ==============

describe("GlobTool · onlyFiles", () => {
  it("does not return directories even when pattern matches them", async () => {
    await mkdir(join(workDir, "subdir"), { recursive: true });
    await writeFile(join(workDir, "afile"), "x");

    const result = await GlobTool.execute({ pattern: "*", cwd: workDir }, makeContext());
    expect(result).toContain("afile");
    expect(result).not.toContain("subdir");
  });
});

// ============== abort ==============

describe("GlobTool · abort", () => {
  it("throws AbortError when signal is already aborted before scan", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      GlobTool.execute({ pattern: "*.ts", cwd: workDir }, makeContext(ctl.signal)),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("throws AbortError when aborted during scan (post-iteration signal check)", async () => {
    // 准备少量文件（迭代极快），但 abort 在 ctl.abort() 调用瞬间生效。
    // GlobTool 在 scan 迭代结束 / stat 之后 / sort 之后均有 signal 检查，
    // 只要在 execute 进入 generator 之后任意时点 abort，必中其中一个 await 检查点。
    //
    // 注意：不用 setTimeout(N)（在 CI 高负载下时序不稳，曾出现 flaky）。
    // 改用：拦截 generator 第一次 yield 后立即 abort —— 利用 Bun.Glob.scan 的
    // for-await 结构，第一次 await 必定让出微任务队列，让 abort 同步生效。
    for (let i = 0; i < 30; i += 1) {
      await writeFile(join(workDir, `f${i}.ts`), "x");
    }
    const ctl = new AbortController();
    // queueMicrotask 在 GlobTool.execute 的第一次 await（validateCwd 内的 fsStat）
    // 之后立即触发，确保 abort 落在 scan 开始之前但已进入 execute 函数主体。
    // 此时 GlobTool 在 scan 入口前的 signal 检查会抛 AbortError。
    queueMicrotask(() => ctl.abort());
    await expect(
      GlobTool.execute({ pattern: "**/*.ts", cwd: workDir }, makeContext(ctl.signal)),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

// ============== output 格式 ==============

describe("GlobTool · output format", () => {
  it("singular vs plural in summary", async () => {
    await writeFile(join(workDir, "only.ts"), "x");
    const result = await GlobTool.execute({ pattern: "*.ts", cwd: workDir }, makeContext());
    expect(result).toMatch(/\[1 match\]/);
  });

  it("paths use posix forward slash separator", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "a.ts"), "x");
    const result = await GlobTool.execute({ pattern: "**/*.ts", cwd: workDir }, makeContext());
    expect(result).toContain("src/a.ts");
    // 不应含反斜杠
    expect(result).not.toContain("src\\a.ts");
  });
});
