/**
 * bashRuleMatcher 单元测试。
 *
 * 覆盖 plan §二中四种 ruleContent 形态的全部语义分支：
 * - undefined / "" → 匹配所有
 * - "git"          → 精确单 token
 * - "git:*"        → 首 token 前缀
 * - "git status"   → 精确两 token
 * - "git status:*" → 首两 token 前缀
 *
 * 同时覆盖 pipeline 截断（只看第一段）和空白参数场景。
 */

import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "../../types/permissions.ts";
import { matchBashRule } from "./bashRuleMatcher.ts";

function rule(ruleContent?: string): PermissionRule {
  return { toolName: "Bash", ruleContent, behavior: "allow" };
}

describe("matchBashRule — undefined / 空", () => {
  test("undefined 匹配任意命令", () => {
    expect(matchBashRule(rule(undefined), "git status")).toBe(true);
    expect(matchBashRule(rule(undefined), "rm -rf /")).toBe(true);
    expect(matchBashRule(rule(undefined), "")).toBe(true);
  });

  test("空字符串匹配任意命令", () => {
    expect(matchBashRule(rule(""), "git status")).toBe(true);
  });
});

describe("matchBashRule — 单 token 精确匹配 'git'", () => {
  test("命中裸 git", () => {
    expect(matchBashRule(rule("git"), "git")).toBe(true);
  });

  test("不命中 git status（多 token）", () => {
    expect(matchBashRule(rule("git"), "git status")).toBe(false);
  });

  test("不命中 gitk（不同命令名）", () => {
    expect(matchBashRule(rule("git"), "gitk")).toBe(false);
  });

  test("前后空白不影响匹配", () => {
    expect(matchBashRule(rule("git"), "  git  ")).toBe(true);
  });
});

describe("matchBashRule — 单 token 前缀 'git:*'", () => {
  test("命中 git status", () => {
    expect(matchBashRule(rule("git:*"), "git status")).toBe(true);
  });

  test("命中裸 git（前缀至少覆盖自身）", () => {
    expect(matchBashRule(rule("git:*"), "git")).toBe(true);
  });

  test("命中带参数 git commit -m 'x'", () => {
    expect(matchBashRule(rule("git:*"), "git commit -m 'feat: x'")).toBe(true);
  });

  test("不命中 gitk（不同命令名）", () => {
    expect(matchBashRule(rule("git:*"), "gitk --all")).toBe(false);
  });

  test("不命中 sudo git（首 token 不同）", () => {
    expect(matchBashRule(rule("git:*"), "sudo git status")).toBe(false);
  });
});

describe("matchBashRule — 双 token 精确 'git status'", () => {
  test("命中裸 git status", () => {
    expect(matchBashRule(rule("git status"), "git status")).toBe(true);
  });

  test("不命中 git status -v（多了参数）", () => {
    expect(matchBashRule(rule("git status"), "git status -v")).toBe(false);
  });

  test("不命中 git push（子命令不同）", () => {
    expect(matchBashRule(rule("git status"), "git push")).toBe(false);
  });
});

describe("matchBashRule — 双 token 前缀 'git status:*'", () => {
  test("命中 git status", () => {
    expect(matchBashRule(rule("git status:*"), "git status")).toBe(true);
  });

  test("命中带参数 git status -v", () => {
    expect(matchBashRule(rule("git status:*"), "git status -v")).toBe(true);
  });

  test("命中 git status --porcelain", () => {
    expect(matchBashRule(rule("git status:*"), "git status --porcelain")).toBe(true);
  });

  test("不命中 git push", () => {
    expect(matchBashRule(rule("git status:*"), "git push origin main")).toBe(false);
  });

  test("不命中裸 git（token 数不够）", () => {
    expect(matchBashRule(rule("git status:*"), "git")).toBe(false);
  });
});

describe("matchBashRule — pipeline / 分隔符截断", () => {
  test("只匹配第一段 pipeline：git status | less 命中 git:*", () => {
    expect(matchBashRule(rule("git:*"), "git status | less")).toBe(true);
  });

  test("第二段 pipeline 不参与匹配：ls | git 不命中 git:*", () => {
    expect(matchBashRule(rule("git:*"), "ls | git")).toBe(false);
  });

  test("&& 分隔：第二条不参与", () => {
    expect(matchBashRule(rule("git:*"), "git status && git push")).toBe(true);
    expect(matchBashRule(rule("git:*"), "ls && git status")).toBe(false);
  });

  test("; 分隔：第二条不参与", () => {
    expect(matchBashRule(rule("git push:*"), "git status; git push")).toBe(false);
  });
});

describe("matchBashRule — 退化 / 容错", () => {
  test("ruleContent 为 ':*' —— 解析后 pattern 为空，视为不匹配", () => {
    expect(matchBashRule(rule(":*"), "git status")).toBe(false);
  });

  test("ruleContent 全空白 —— 不匹配（避免误触全放行）", () => {
    expect(matchBashRule(rule("   "), "git status")).toBe(false);
  });
});
