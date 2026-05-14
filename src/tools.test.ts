/**
 * 工具注册表层级测试。
 *
 * 包含两类测试：
 * 1. findTool 基础查找语义（从原 src/llm/tools.test.ts 迁移而来）
 * 2. 工具命名一致性 smoke test —— v2.2 评审 · 代码质量 Issue #1 增补，防止新增
 *    工具时类名 / Tool.name 字段拼写漂移到 prod 才暴露
 *    （见 docs/design/M1-tools.md §8.1 测试矩阵）
 */

import { describe, expect, test } from "bun:test";
import type { Tool } from "./Tool.ts";
import {
  BashTool,
  builtinTools,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  findTool,
  GlobTool,
  GrepTool,
  LSTool,
  TodoWriteTool,
} from "./tools.ts";

describe("builtinTools 注册表", () => {
  test("包含 M6 全部 8 个工具", () => {
    const names = builtinTools.map((t) => t.name);
    expect(names).toContain("LS");
    expect(names).toContain("FileRead");
    expect(names).toContain("FileWrite");
    expect(names).toContain("FileEdit");
    expect(names).toContain("Bash");
    expect(names).toContain("Grep");
    expect(names).toContain("Glob");
    expect(names).toContain("TodoWrite");
  });

  test("findTool 按名严格查找", () => {
    expect(findTool("LS", builtinTools)?.name).toBe("LS");
    expect(findTool("FileRead", builtinTools)?.name).toBe("FileRead");
    expect(findTool("nonexistent", builtinTools)).toBeUndefined();
  });

  test("findTool 大小写敏感（snake_case 旧名不再可用）", () => {
    // 防止有人依赖旧 list_dir / read_file 名字
    expect(findTool("list_dir", builtinTools)).toBeUndefined();
    expect(findTool("read_file", builtinTools)).toBeUndefined();
  });
});

describe("工具命名一致性 smoke test（v2.2 评审 · 代码质量 Issue #1）", () => {
  /**
   * 静态映射表：每个内置工具的"实例 ↔ 期望 name 字段值"。
   * 新增工具时必须同步此表，否则下方"全集覆盖"测试会断在数量比对。
   */
  const BUILTIN_TOOLS_NAMING: ReadonlyArray<{
    readonly tool: Tool;
    readonly expectedName: string;
  }> = [
    { tool: LSTool, expectedName: "LS" },
    { tool: FileReadTool, expectedName: "FileRead" },
    { tool: FileWriteTool, expectedName: "FileWrite" },
    { tool: FileEditTool, expectedName: "FileEdit" },
    { tool: BashTool, expectedName: "Bash" },
    { tool: GrepTool, expectedName: "Grep" },
    { tool: GlobTool, expectedName: "Glob" },
    { tool: TodoWriteTool, expectedName: "TodoWrite" },
  ];

  test("name 字段非空且为字符串", () => {
    for (const tool of builtinTools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  test("name 字段仅含 [A-Za-z0-9]（PascalCase 字面量校验，禁止 snake_case 误回归）", () => {
    const pascalLike = /^[A-Za-z][A-Za-z0-9]*$/;
    for (const tool of builtinTools) {
      expect(tool.name).toMatch(pascalLike);
      // 显式禁止 snake_case 与 kebab-case
      expect(tool.name).not.toContain("_");
      expect(tool.name).not.toContain("-");
    }
  });

  test("静态映射表覆盖 builtinTools 全集（新增工具必须同步）", () => {
    expect(BUILTIN_TOOLS_NAMING.length).toBe(builtinTools.length);
    for (const { tool, expectedName } of BUILTIN_TOOLS_NAMING) {
      expect(tool.name).toBe(expectedName);
      expect(builtinTools).toContain(tool);
    }
  });

  test("builtinTools 中 name 字段全集无重复", () => {
    const names = builtinTools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
