/**
 * permissionStore 单元测试。
 *
 * 覆盖：
 * 1. 路径计算（project / global）
 * 2. loadRulesFromFile：缺文件 / 坏 JSON / 版本错 / 规则非法
 * 3. saveRulesToFile：建父目录 + 往返读写
 * 4. upsertRule / removeRuleByKey 纯函数
 * 5. PermissionStore 类：load / addRule / removeRule / getMergedRules 顺序
 *
 * 所有 IO 走 mkdtemp 隔离，不碰真实 ~/.nova-code。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../errors/index.ts";
import type { PermissionRule } from "../../types/permissions.ts";
import { permissionRuleKey } from "./PermissionRule.ts";
import {
  getGlobalPermissionsPath,
  getProjectPermissionsPath,
  loadRulesFromFile,
  PermissionStore,
  removeRuleByKey,
  saveRulesToFile,
  upsertRule,
} from "./permissionStore.ts";

async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function mkRule(
  toolName: string,
  behavior: PermissionRule["behavior"],
  ruleContent?: string,
): PermissionRule {
  return { toolName, behavior, ...(ruleContent === undefined ? {} : { ruleContent }) };
}

// ────────────────────────────────────────────────────────────────────────────
// 路径计算
// ────────────────────────────────────────────────────────────────────────────

describe("getProjectPermissionsPath / getGlobalPermissionsPath", () => {
  test("project 路径 = <cwd>/.nova-code/permissions.json", () => {
    expect(getProjectPermissionsPath("/repo")).toMatch(
      /[\\/]repo[\\/]\.nova-code[\\/]permissions\.json$/,
    );
  });

  test("global 路径 = <homeDir>/.nova-code/permissions.json", () => {
    expect(getGlobalPermissionsPath({ homeDir: "/fake/home" })).toMatch(
      /[\\/]fake[\\/]home[\\/]\.nova-code[\\/]permissions\.json$/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// loadRulesFromFile
// ────────────────────────────────────────────────────────────────────────────

describe("loadRulesFromFile", () => {
  test("文件不存在 → 空数组", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-miss-");
    try {
      const rules = await loadRulesFromFile(join(dir, "nope.json"));
      expect(rules).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("坏 JSON → ConfigError", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-bad-");
    try {
      const path = join(dir, "p.json");
      await writeFile(path, "{not json", "utf8");
      await expect(loadRulesFromFile(path)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await cleanup();
    }
  });

  test("顶层非对象 → ConfigError", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-arr-");
    try {
      const path = join(dir, "p.json");
      await writeFile(path, "[]", "utf8");
      await expect(loadRulesFromFile(path)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await cleanup();
    }
  });

  test("version 不为 1 → ConfigError", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-ver-");
    try {
      const path = join(dir, "p.json");
      await writeFile(path, JSON.stringify({ version: 2, rules: [] }), "utf8");
      await expect(loadRulesFromFile(path)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await cleanup();
    }
  });

  test("rules 非数组 → ConfigError", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-rules-");
    try {
      const path = join(dir, "p.json");
      await writeFile(path, JSON.stringify({ version: 1, rules: "oops" }), "utf8");
      await expect(loadRulesFromFile(path)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await cleanup();
    }
  });

  test("单条 rule 非法 → ConfigError，提示 rule 索引", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-invalid-");
    try {
      const path = join(dir, "p.json");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          rules: [mkRule("Bash", "allow", "git:*"), { toolName: "Bash" /* missing behavior */ }],
        }),
        "utf8",
      );
      await expect(loadRulesFromFile(path)).rejects.toThrow(/rule #1/);
    } finally {
      await cleanup();
    }
  });

  test("合法文件 → 返回规则列表", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-load-ok-");
    try {
      const path = join(dir, "p.json");
      const rules = [mkRule("Bash", "allow", "git:*"), mkRule("FileWrite", "deny", "*.key")];
      await writeFile(path, JSON.stringify({ version: 1, rules }), "utf8");
      const loaded = await loadRulesFromFile(path);
      expect(loaded).toEqual(rules);
    } finally {
      await cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// saveRulesToFile
// ────────────────────────────────────────────────────────────────────────────

describe("saveRulesToFile", () => {
  test("自动建父目录并写入", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-save-");
    try {
      const path = join(dir, "nested", "subdir", "p.json");
      await saveRulesToFile(path, [mkRule("Bash", "allow", "git:*")]);
      const loaded = await loadRulesFromFile(path);
      expect(loaded).toEqual([mkRule("Bash", "allow", "git:*")]);
    } finally {
      await cleanup();
    }
  });

  test("往返写入与加载保持一致", async () => {
    const { dir, cleanup } = await tempDir("nova-perm-roundtrip-");
    try {
      const path = join(dir, "p.json");
      const rules = [
        mkRule("Bash", "allow", "git:*"),
        mkRule("FileWrite", "deny", "*.key"),
        mkRule("FileRead", "ask"),
      ];
      await saveRulesToFile(path, rules);
      expect(await loadRulesFromFile(path)).toEqual(rules);
    } finally {
      await cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// upsertRule / removeRuleByKey
// ────────────────────────────────────────────────────────────────────────────

describe("upsertRule", () => {
  test("key 不存在 → 追加", () => {
    const result = upsertRule([], mkRule("Bash", "allow", "git:*"));
    expect(result).toEqual([mkRule("Bash", "allow", "git:*")]);
  });

  test("key 已存在 → 替换（保持位置）", () => {
    const before = [mkRule("Bash", "allow", "git:*"), mkRule("FileWrite", "allow", "src/**/*.ts")];
    const after = upsertRule(before, mkRule("Bash", "deny", "git:*"));
    expect(after).toEqual([
      mkRule("Bash", "deny", "git:*"),
      mkRule("FileWrite", "allow", "src/**/*.ts"),
    ]);
  });

  test("不同 toolName 但同 ruleContent 不算同 key", () => {
    const before = [mkRule("Bash", "allow", "git")];
    const after = upsertRule(before, mkRule("FileWrite", "allow", "git"));
    expect(after.length).toBe(2);
  });

  test("返回新数组，不原地修改", () => {
    const before: readonly PermissionRule[] = [mkRule("Bash", "allow", "git:*")];
    const after = upsertRule(before, mkRule("Bash", "deny", "git:*"));
    expect(before).toEqual([mkRule("Bash", "allow", "git:*")]); // 原数组未变
    expect(after).not.toBe(before);
  });
});

describe("removeRuleByKey", () => {
  test("命中 → 返回不含该条的新数组", () => {
    const before = [mkRule("Bash", "allow", "git:*"), mkRule("FileWrite", "deny", "*.key")];
    const target = mkRule("Bash", "allow", "git:*");
    const after = removeRuleByKey(before, permissionRuleKey(target));
    expect(after).toEqual([mkRule("FileWrite", "deny", "*.key")]);
  });

  test("未命中 → 返回等价数组", () => {
    const before = [mkRule("Bash", "allow", "git:*")];
    const after = removeRuleByKey(before, "NoSuch\t");
    expect(after).toEqual(before);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PermissionStore 类
// ────────────────────────────────────────────────────────────────────────────

describe("PermissionStore.load", () => {
  test("两层都缺文件 → 空规则", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-store-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-store-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      expect(store.getMergedRules()).toEqual([]);
    } finally {
      await c1();
      await c2();
    }
  });

  test("并行加载 project + global", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-store-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-store-home-");
    try {
      await mkdir(join(cwd, ".nova-code"), { recursive: true });
      await writeFile(
        getProjectPermissionsPath(cwd),
        JSON.stringify({ version: 1, rules: [mkRule("Bash", "allow", "git:*")] }),
        "utf8",
      );
      await mkdir(join(home, ".nova-code"), { recursive: true });
      await writeFile(
        getGlobalPermissionsPath({ homeDir: home }),
        JSON.stringify({ version: 1, rules: [mkRule("FileRead", "ask")] }),
        "utf8",
      );
      const store = await PermissionStore.load(cwd, { homeDir: home });
      const merged = store.getMergedRules();
      expect(merged).toEqual([
        { source: "project", rule: mkRule("Bash", "allow", "git:*") },
        { source: "global", rule: mkRule("FileRead", "ask") },
      ]);
    } finally {
      await c1();
      await c2();
    }
  });
});

describe("PermissionStore.addRule", () => {
  test("session：只改内存，不写盘", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-add-session-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-add-session-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("session", mkRule("Bash", "allow", "git:*"));
      expect(store.listBySource("session")).toEqual([mkRule("Bash", "allow", "git:*")]);
      // 磁盘依然不存在
      expect(await loadRulesFromFile(getProjectPermissionsPath(cwd))).toEqual([]);
      expect(await loadRulesFromFile(getGlobalPermissionsPath({ homeDir: home }))).toEqual([]);
    } finally {
      await c1();
      await c2();
    }
  });

  test("project：改内存 + 写 cwd 下的文件", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-add-proj-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-add-proj-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("project", mkRule("Bash", "allow", "git:*"));
      expect(await loadRulesFromFile(getProjectPermissionsPath(cwd))).toEqual([
        mkRule("Bash", "allow", "git:*"),
      ]);
    } finally {
      await c1();
      await c2();
    }
  });

  test("global：改内存 + 写 home 下的文件", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-add-glb-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-add-glb-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("global", mkRule("FileRead", "ask"));
      expect(await loadRulesFromFile(getGlobalPermissionsPath({ homeDir: home }))).toEqual([
        mkRule("FileRead", "ask"),
      ]);
    } finally {
      await c1();
      await c2();
    }
  });

  test("重复 key 覆盖 behavior", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-add-dup-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-add-dup-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("session", mkRule("Bash", "allow", "git:*"));
      await store.addRule("session", mkRule("Bash", "deny", "git:*"));
      expect(store.listBySource("session")).toEqual([mkRule("Bash", "deny", "git:*")]);
    } finally {
      await c1();
      await c2();
    }
  });

  test("非法规则 → ConfigError", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-add-bad-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-add-bad-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      // @ts-expect-error 故意传非法形状触发运行时校验
      await expect(store.addRule("session", { toolName: "" })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await c1();
      await c2();
    }
  });
});

describe("PermissionStore.removeRule", () => {
  test("命中 → 返回 true + 更新内存", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-rm-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-rm-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("session", mkRule("Bash", "allow", "git:*"));
      const key = permissionRuleKey(mkRule("Bash", "allow", "git:*"));
      const removed = await store.removeRule("session", key);
      expect(removed).toBe(true);
      expect(store.listBySource("session")).toEqual([]);
    } finally {
      await c1();
      await c2();
    }
  });

  test("未命中 → 返回 false，内存不变", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-rm-miss-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-rm-miss-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      const removed = await store.removeRule("session", "NoSuch\t");
      expect(removed).toBe(false);
    } finally {
      await c1();
      await c2();
    }
  });

  test("project：删除后写回文件", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-rm-proj-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-rm-proj-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("project", mkRule("Bash", "allow", "git:*"));
      await store.addRule("project", mkRule("FileWrite", "allow", "**/*"));
      await store.removeRule("project", permissionRuleKey(mkRule("Bash", "allow", "git:*")));
      expect(await loadRulesFromFile(getProjectPermissionsPath(cwd))).toEqual([
        mkRule("FileWrite", "allow", "**/*"),
      ]);
    } finally {
      await c1();
      await c2();
    }
  });
});

describe("PermissionStore.getMergedRules 顺序", () => {
  test("session 先 / project 次 / global 末", async () => {
    const { dir: cwd, cleanup: c1 } = await tempDir("nova-perm-order-cwd-");
    const { dir: home, cleanup: c2 } = await tempDir("nova-perm-order-home-");
    try {
      const store = await PermissionStore.load(cwd, { homeDir: home });
      await store.addRule("global", mkRule("A", "allow"));
      await store.addRule("project", mkRule("B", "allow"));
      await store.addRule("session", mkRule("C", "allow"));
      const merged = store.getMergedRules();
      expect(merged.map((m) => m.source)).toEqual(["session", "project", "global"]);
      expect(merged.map((m) => m.rule.toolName)).toEqual(["C", "B", "A"]);
    } finally {
      await c1();
      await c2();
    }
  });
});
