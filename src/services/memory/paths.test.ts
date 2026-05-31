import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ENTRYPOINT_NAME,
  ensureMemoryDirExists,
  getAutoMemEntrypoint,
  getAutoMemPath,
  getMemoryBaseDir,
  isAutoMemoryEnabled,
  isAutoMemPath,
} from "./paths.ts";

describe("getMemoryBaseDir", () => {
  test("默认基于 homedir", () => {
    const env: Record<string, string | undefined> = {};
    expect(getMemoryBaseDir(env)).toContain(".nova-code");
    expect(getMemoryBaseDir(env)).toContain("memory");
  });

  test("NOVA_MEMORY_DIR env 覆盖", () => {
    expect(getMemoryBaseDir({ NOVA_MEMORY_DIR: "/custom/mem" })).toBe("/custom/mem");
  });
});

describe("getAutoMemPath", () => {
  test("git 仓库内：基于 git root 计算 sanitized key", async () => {
    const root = await mkdtemp(join(tmpdir(), "novamem-git-"));
    try {
      await mkdir(join(root, ".git"), { recursive: true });
      const sub = join(root, "sub", "deep");
      await mkdir(sub, { recursive: true });

      const path = await getAutoMemPath({
        cwd: sub,
        env: {},
        homeDir: "/fake-home",
      });
      // 路径末尾带 sep
      expect(path.endsWith(sep)).toBe(true);
      // 包含 sanitize 后的 git root（替换 / 为 -）
      expect(path).toContain(root.replaceAll("/", "-"));
      // 子目录 sub/deep 不出现在 key 里（被 git root 覆盖）
      expect(path).not.toContain("deep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("非 git 目录：回退到 cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "novamem-nogit-"));
    try {
      const path = await getAutoMemPath({
        cwd,
        env: {},
        homeDir: "/fake-home",
      });
      expect(path).toContain(cwd.replaceAll("/", "-"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("env override 改变 base 目录", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "novamem-env-"));
    try {
      const path = await getAutoMemPath({
        cwd,
        env: { NOVA_MEMORY_DIR: "/custom/base" },
      });
      expect(path.startsWith("/custom/base/")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("getAutoMemEntrypoint", () => {
  test("末尾是 MEMORY.md", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "novamem-ep-"));
    try {
      const ep = await getAutoMemEntrypoint({ cwd, env: {} });
      expect(ep.endsWith(ENTRYPOINT_NAME)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("isAutoMemoryEnabled", () => {
  test("默认开", () => {
    expect(isAutoMemoryEnabled({ env: {} })).toBe(true);
  });

  test("env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 → 关", () => {
    expect(isAutoMemoryEnabled({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } })).toBe(false);
    expect(isAutoMemoryEnabled({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "true" } })).toBe(false);
  });

  test("config autoMemoryEnabled=false → 关", () => {
    expect(isAutoMemoryEnabled({ env: {}, configAutoMemoryEnabled: false })).toBe(false);
  });

  test("env 关 > config 开（env 优先）", () => {
    expect(
      isAutoMemoryEnabled({
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
        configAutoMemoryEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("isAutoMemPath", () => {
  test("路径在 memoryDir 内 → true", () => {
    expect(isAutoMemPath("/mem/projects/foo/note.md", "/mem/projects/foo/")).toBe(true);
  });

  test("memoryDir 自身路径 → true", () => {
    expect(isAutoMemPath("/mem/projects/foo", "/mem/projects/foo/")).toBe(true);
  });

  test("相对路径 → 绝对化后判断", () => {
    const cwd = process.cwd();
    const memDir = `${cwd}/mem/`;
    expect(isAutoMemPath("mem/note.md", memDir)).toBe(true);
  });

  test("prefix 攻击：/mem/projects/foo-evil 不匹配 /mem/projects/foo/", () => {
    expect(isAutoMemPath("/mem/projects/foo-evil/note.md", "/mem/projects/foo/")).toBe(false);
  });

  test("`..` 越狱攻击拒绝", () => {
    expect(isAutoMemPath("/mem/projects/foo/../../etc/passwd", "/mem/projects/foo/")).toBe(false);
  });

  test("null byte 拒绝", () => {
    expect(isAutoMemPath("/mem/projects/foo/\0bad", "/mem/projects/foo/")).toBe(false);
  });
});

describe("ensureMemoryDirExists", () => {
  test("不存在时创建（递归）", async () => {
    const base = await mkdtemp(join(tmpdir(), "novamem-mk-"));
    try {
      const target = join(base, "a", "b", "c");
      await ensureMemoryDirExists(target);
      const probe = join(target, "probe.txt");
      await writeFile(probe, "ok");
      // 不抛即视为成功
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("已存在不抛", async () => {
    const base = await mkdtemp(join(tmpdir(), "novamem-mk-existing-"));
    try {
      await ensureMemoryDirExists(base);
      await ensureMemoryDirExists(base);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
