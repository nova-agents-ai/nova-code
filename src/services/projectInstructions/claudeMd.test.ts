import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractIncludePaths, getProjectInstructions } from "./claudeMd.ts";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "nova-pi-"));
});

afterEach(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// extractIncludePaths
// ────────────────────────────────────────────────────────────────────────────

describe("extractIncludePaths", () => {
  test("匹配独立行的 @relative", () => {
    const paths = extractIncludePaths("hello\n@./extra.md\nworld", "/base/CLAUDE.md");
    expect(paths).toEqual(["/base/extra.md"]);
  });

  test("匹配 @path 不带 ./", () => {
    const paths = extractIncludePaths("@extra.md", "/base/CLAUDE.md");
    expect(paths).toEqual(["/base/extra.md"]);
  });

  test("匹配 @/abs", () => {
    const paths = extractIncludePaths("@/etc/x.md", "/base/CLAUDE.md");
    expect(paths).toEqual(["/etc/x.md"]);
  });

  test("跳过 fenced code block 内的 @path", () => {
    const md = "@./yes.md\n```\n@./no.md\n```\n@./yes2.md";
    const paths = extractIncludePaths(md, "/base/CLAUDE.md");
    expect(paths).toEqual(["/base/yes.md", "/base/yes2.md"]);
  });

  test("行内 @path 算 include（claude-code 同款语义）", () => {
    const md = "see @./inline.md for details";
    expect(extractIncludePaths(md, "/base/CLAUDE.md")).toEqual(["/base/inline.md"]);
  });

  test("inline code 内的 @path 不算（codespan 跳过）", () => {
    const md = "use `@./not-a-include.md` literally";
    expect(extractIncludePaths(md, "/base/CLAUDE.md")).toEqual([]);
  });

  test("剥 fragment：@./x.md#heading → /base/x.md", () => {
    expect(extractIncludePaths("@./x.md#heading", "/base/CLAUDE.md")).toEqual(["/base/x.md"]);
  });

  test("escaped space：@./has\\ space.md → /base/has space.md", () => {
    expect(extractIncludePaths("@./has\\ space.md", "/base/CLAUDE.md")).toEqual([
      "/base/has space.md",
    ]);
  });

  test("拒绝纯 @/、@@ 等非法形态", () => {
    expect(extractIncludePaths("@/", "/base/CLAUDE.md")).toEqual([]);
    expect(extractIncludePaths("@@nope", "/base/CLAUDE.md")).toEqual([]);
    expect(extractIncludePaths("@#hash", "/base/CLAUDE.md")).toEqual([]);
  });

  test("空字符串返回空数组", () => {
    expect(extractIncludePaths("", "/base/CLAUDE.md")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getProjectInstructions
// ────────────────────────────────────────────────────────────────────────────

describe("getProjectInstructions", () => {
  test("没有任何 CLAUDE.md → undefined", async () => {
    const result = await getProjectInstructions({
      cwd: tmpRoot,
      homeDir: tmpRoot,
      managedDir: join(tmpRoot, "etc"), // 不存在
    });
    expect(result).toBeUndefined();
  });

  test("仅 user 层有 → 输出包含 user 层内容", async () => {
    await Bun.write(join(tmpRoot, ".nova-code", "CLAUDE.md"), "USER LAYER CONTENT");
    const result = await getProjectInstructions({
      cwd: tmpRoot,
      homeDir: tmpRoot,
      managedDir: join(tmpRoot, "etc"),
    });
    expect(result).toBeDefined();
    expect(result).toContain("USER LAYER CONTENT");
    expect(result).toContain("Codebase and user instructions");
  });

  test("project 层 CLAUDE.md 被加载", async () => {
    // 设 project = tmpRoot/proj，cwd = proj/sub
    const projDir = join(tmpRoot, "proj");
    await Bun.write(join(projDir, "CLAUDE.md"), "PROJECT INSTRUCTIONS");
    // 模拟 git root：在 projDir 写一个空的 .git 文件
    await Bun.write(join(projDir, ".git"), "gitdir: fake");
    const cwd = join(projDir, "sub");
    await Bun.write(join(cwd, ".keep"), "");

    const result = await getProjectInstructions({
      cwd,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: join(tmpRoot, "etc-empty"),
    });
    expect(result).toContain("PROJECT INSTRUCTIONS");
  });

  test("local 层 CLAUDE.local.md 比 project 层后加载（顺序断言）", async () => {
    const projDir = join(tmpRoot, "proj");
    await Bun.write(join(projDir, "CLAUDE.md"), "PROJECT_LAYER");
    await Bun.write(join(projDir, "CLAUDE.local.md"), "LOCAL_LAYER");
    await Bun.write(join(projDir, ".git"), "gitdir: fake");

    const result = await getProjectInstructions({
      cwd: projDir,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: join(tmpRoot, "etc-empty"),
    });
    expect(result).toBeDefined();
    const projectIdx = result?.indexOf("PROJECT_LAYER") ?? -1;
    const localIdx = result?.indexOf("LOCAL_LAYER") ?? -1;
    expect(projectIdx).toBeGreaterThan(-1);
    expect(localIdx).toBeGreaterThan(projectIdx);
  });

  test("@include 子文件先于父文件加载 + 都出现在结果里", async () => {
    const projDir = join(tmpRoot, "proj");
    await Bun.write(join(projDir, ".git"), "gitdir: fake");
    await Bun.write(join(projDir, "extra.md"), "EXTRA_CONTENT");
    await Bun.write(join(projDir, "CLAUDE.md"), "PARENT_BEGIN\n@./extra.md\nPARENT_END");

    const result = await getProjectInstructions({
      cwd: projDir,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: join(tmpRoot, "etc-empty"),
    });
    expect(result).toBeDefined();
    expect(result).toContain("EXTRA_CONTENT");
    expect(result).toContain("PARENT_BEGIN");
    // include 先 push → EXTRA 在 PARENT 之前
    const extraIdx = result?.indexOf("EXTRA_CONTENT") ?? -1;
    const parentIdx = result?.indexOf("PARENT_BEGIN") ?? -1;
    expect(extraIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeGreaterThan(-1);
    expect(extraIdx).toBeLessThan(parentIdx);
  });

  test("循环 @include 不死循环（visited 集合保护）", async () => {
    const projDir = join(tmpRoot, "proj");
    await Bun.write(join(projDir, ".git"), "gitdir: fake");
    await Bun.write(join(projDir, "CLAUDE.md"), "A_CONTENT\n@./b.md");
    await Bun.write(join(projDir, "b.md"), "B_CONTENT\n@./CLAUDE.md");

    const result = await getProjectInstructions({
      cwd: projDir,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: join(tmpRoot, "etc-empty"),
    });
    expect(result).toBeDefined();
    expect(result).toContain("A_CONTENT");
    expect(result).toContain("B_CONTENT");
    // 各文件应只出现一次
    const aMatches = (result?.match(/A_CONTENT/g) ?? []).length;
    expect(aMatches).toBe(1);
  });

  test("Windows 平台跳过 managed 层", async () => {
    // 构造一个 managedDir 但平台传 win32 → 不应加载
    const managed = join(tmpRoot, "etc-managed");
    await Bun.write(join(managed, "CLAUDE.md"), "MANAGED_LAYER");

    const result = await getProjectInstructions({
      cwd: tmpRoot,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: managed,
      platform: "win32",
    });
    // 没有别的 layer 命中 → undefined
    expect(result).toBeUndefined();
  });

  test("非 Windows 平台加载 managed 层", async () => {
    const managed = join(tmpRoot, "etc-managed");
    await Bun.write(join(managed, "CLAUDE.md"), "MANAGED_LAYER");

    const result = await getProjectInstructions({
      cwd: tmpRoot,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: managed,
      platform: "linux",
    });
    expect(result).toContain("MANAGED_LAYER");
  });

  test("project 层覆盖：dirChain 从 git root 到 cwd 都扫", async () => {
    const projDir = join(tmpRoot, "proj");
    const subDir = join(projDir, "sub");
    await Bun.write(join(projDir, ".git"), "gitdir: fake");
    await Bun.write(join(projDir, "CLAUDE.md"), "ROOT_DOC");
    await Bun.write(join(subDir, "CLAUDE.md"), "SUB_DOC");

    const result = await getProjectInstructions({
      cwd: subDir,
      homeDir: join(tmpRoot, "home-empty"),
      managedDir: join(tmpRoot, "etc-empty"),
    });
    expect(result).toContain("ROOT_DOC");
    expect(result).toContain("SUB_DOC");
    // ROOT_DOC 先加载（priority 较低）→ SUB_DOC 后加载
    const rootIdx = result?.indexOf("ROOT_DOC") ?? -1;
    const subIdx = result?.indexOf("SUB_DOC") ?? -1;
    expect(rootIdx).toBeLessThan(subIdx);
  });
});
