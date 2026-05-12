/**
 * fileRuleMatcher 单元测试。
 *
 * 覆盖：
 * 1. glob 语法：`*` / `**` / `?` / `[...]` / 字面字符
 * 2. 绝对 / 相对路径的 cwd 相对化
 * 3. extractFilePath 的健壮性
 *
 * cwd 统一用 "/work"（POSIX 语义），规避测试机真实 cwd 差异。
 */

import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "../../types/permissions.ts";
import {
  extractFilePath,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  isFileWriteToolName,
  matchFileRule,
} from "./fileRuleMatcher.ts";

const CWD = "/work";

function rule(ruleContent?: string): PermissionRule {
  return { toolName: FILE_WRITE_TOOL_NAME, ruleContent, behavior: "allow" };
}

describe("isFileWriteToolName", () => {
  test("FileWrite 返回 true", () => {
    expect(isFileWriteToolName(FILE_WRITE_TOOL_NAME)).toBe(true);
  });

  test("FileEdit 返回 true", () => {
    expect(isFileWriteToolName(FILE_EDIT_TOOL_NAME)).toBe(true);
  });

  test("Bash 返回 false", () => {
    expect(isFileWriteToolName("Bash")).toBe(false);
  });

  test("FileRead 返回 false（只读不归此匹配器）", () => {
    expect(isFileWriteToolName("FileRead")).toBe(false);
  });
});

describe("matchFileRule — undefined / 空 ruleContent", () => {
  test("undefined 匹配任意路径", () => {
    expect(matchFileRule(rule(undefined), "src/a.ts", CWD)).toBe(true);
    expect(matchFileRule(rule(undefined), "/any/where/b.py", CWD)).toBe(true);
  });

  test("空字符串匹配任意路径", () => {
    expect(matchFileRule(rule(""), "src/a.ts", CWD)).toBe(true);
  });
});

describe("matchFileRule — 单层 glob '*'", () => {
  test("src/*.ts 命中 src/foo.ts", () => {
    expect(matchFileRule(rule("src/*.ts"), "src/foo.ts", CWD)).toBe(true);
  });

  test("src/*.ts 不命中 src/nested/foo.ts（* 不跨 /）", () => {
    expect(matchFileRule(rule("src/*.ts"), "src/nested/foo.ts", CWD)).toBe(false);
  });

  test("src/*.ts 不命中 src/foo.js（后缀不同）", () => {
    expect(matchFileRule(rule("src/*.ts"), "src/foo.js", CWD)).toBe(false);
  });
});

describe("matchFileRule — 递归 glob '**'", () => {
  test("src/**/*.ts 命中 src/foo.ts（零层）", () => {
    expect(matchFileRule(rule("src/**/*.ts"), "src/foo.ts", CWD)).toBe(true);
  });

  test("src/**/*.ts 命中 src/a/b/c/foo.ts（多层）", () => {
    expect(matchFileRule(rule("src/**/*.ts"), "src/a/b/c/foo.ts", CWD)).toBe(true);
  });

  test("docs/** 命中 docs/a/b.md", () => {
    expect(matchFileRule(rule("docs/**"), "docs/a/b.md", CWD)).toBe(true);
  });

  test("docs/** 不命中 src/a.ts", () => {
    expect(matchFileRule(rule("docs/**"), "src/a.ts", CWD)).toBe(false);
  });
});

describe("matchFileRule — 单字符 '?' 和字符类 '[...]'", () => {
  test("src/?.ts 命中 src/a.ts", () => {
    expect(matchFileRule(rule("src/?.ts"), "src/a.ts", CWD)).toBe(true);
  });

  test("src/?.ts 不命中 src/ab.ts", () => {
    expect(matchFileRule(rule("src/?.ts"), "src/ab.ts", CWD)).toBe(false);
  });

  test("src/[abc].ts 命中 src/b.ts", () => {
    expect(matchFileRule(rule("src/[abc].ts"), "src/b.ts", CWD)).toBe(true);
  });

  test("src/[abc].ts 不命中 src/d.ts", () => {
    expect(matchFileRule(rule("src/[abc].ts"), "src/d.ts", CWD)).toBe(false);
  });

  test("src/[!abc].ts 命中 src/d.ts（否定字符类）", () => {
    expect(matchFileRule(rule("src/[!abc].ts"), "src/d.ts", CWD)).toBe(true);
  });

  test("src/[!abc].ts 不命中 src/a.ts", () => {
    expect(matchFileRule(rule("src/[!abc].ts"), "src/a.ts", CWD)).toBe(false);
  });
});

describe("matchFileRule — 绝对路径相对化", () => {
  test("绝对路径命中同 cwd 的相对 glob", () => {
    expect(matchFileRule(rule("src/*.ts"), "/work/src/foo.ts", CWD)).toBe(true);
  });

  test("绝对路径在 cwd 之外：relative 产出 '../...'，按字面匹配", () => {
    // relative("/work", "/other/a.ts") → "../other/a.ts"；普通 glob 匹配不到
    expect(matchFileRule(rule("src/*.ts"), "/other/a.ts", CWD)).toBe(false);
  });
});

describe("matchFileRule — regex 元字符字面化", () => {
  test("文件名中的点按字面匹配，不作为正则 '.'", () => {
    // 如果 '.' 没被转义，以下应命中 —— 但 globToRegExp 必须转义
    expect(matchFileRule(rule("src/ax.ts"), "src/a.ts", CWD)).toBe(false);
  });

  test("'+' 按字面匹配", () => {
    expect(matchFileRule(rule("src/a+b.ts"), "src/a+b.ts", CWD)).toBe(true);
    expect(matchFileRule(rule("src/a+b.ts"), "src/aab.ts", CWD)).toBe(false);
  });
});

describe("extractFilePath", () => {
  test("从 { path: 'a.ts' } 提取", () => {
    expect(extractFilePath({ path: "a.ts" })).toBe("a.ts");
  });

  test("非字符串 path 返回 undefined", () => {
    expect(extractFilePath({ path: 123 })).toBeUndefined();
  });

  test("缺字段返回 undefined", () => {
    expect(extractFilePath({})).toBeUndefined();
  });

  test("null / 数组 / 非对象返回 undefined", () => {
    expect(extractFilePath(null)).toBeUndefined();
    expect(extractFilePath(["a.ts"])).toBeUndefined();
    expect(extractFilePath("a.ts")).toBeUndefined();
  });
});
