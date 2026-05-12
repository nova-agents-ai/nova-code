/**
 * permissionEngine 单元测试。
 *
 * 覆盖七步流水线的每一步，以及步间优先级：
 * 1. DENY_PATTERNS 优先级最高（即便 bypass 也不放过）
 * 2. bypass 绕过 rules/mode/requiresApproval
 * 3. deny 规则不分 source 都最高（仅次于 DENY_PATTERNS 与 bypass 后的 DENY）
 * 4. allow/ask 规则按 session > project > global 排序
 * 5. acceptEdits 只对 FileWrite/FileEdit 生效
 * 6. requiresApproval 作为 ask 的兜底
 * 7. 只读工具默认 allow
 *
 * 测试用 mkRule / mkEntry / evalInput 三个小工具降低样板代码。
 */

import { describe, expect, test } from "bun:test";
import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleWithSource,
} from "../../types/permissions.ts";
import { evaluatePermission } from "./permissionEngine.ts";

const CWD = "/work";

function mkRule(
  toolName: string,
  behavior: PermissionRule["behavior"],
  ruleContent?: string,
): PermissionRule {
  return { toolName, behavior, ruleContent };
}

function mkEntry(
  source: PermissionRuleSource,
  toolName: string,
  behavior: PermissionRule["behavior"],
  ruleContent?: string,
): PermissionRuleWithSource {
  return { source, rule: mkRule(toolName, behavior, ruleContent) };
}

function evalInput(params: {
  mode?: PermissionMode;
  toolName: string;
  requiresApproval?: boolean;
  input?: unknown;
  rules?: readonly PermissionRuleWithSource[];
  cwd?: string;
}) {
  return evaluatePermission({
    mode: params.mode ?? "default",
    toolName: params.toolName,
    requiresApproval: params.requiresApproval ?? false,
    input: params.input ?? {},
    rules: params.rules ?? [],
    cwd: params.cwd ?? CWD,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Step 1: DENY_PATTERNS
// ────────────────────────────────────────────────────────────────────────────
describe("Step 1: DENY_PATTERNS", () => {
  test("rm -rf / → deny，带 denyPatternName", () => {
    const result = evalInput({ toolName: "Bash", input: { command: "rm -rf /" } });
    expect(result.decision).toBe("deny");
    expect(result.denyPatternName).toBe("rm-rf-root");
    expect(result.reason).toContain("DENY pattern");
  });

  test("bypass 也不能绕过 DENY_PATTERNS（深度防御）", () => {
    const result = evalInput({
      mode: "bypassPermissions",
      toolName: "Bash",
      input: { command: "rm -rf /" },
    });
    expect(result.decision).toBe("deny");
    expect(result.denyPatternName).toBe("rm-rf-root");
  });

  test("session allow 规则也不能绕过 DENY_PATTERNS", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "sudo rm -rf /" },
      rules: [mkEntry("session", "Bash", "allow")],
    });
    expect(result.decision).toBe("deny");
  });

  test("DENY_PATTERNS 只对 Bash 生效；FileWrite 不走", () => {
    const result = evalInput({
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "rm -rf /" }, // 故意用危险字符做 path
    });
    expect(result.decision).toBe("ask");
    expect(result.denyPatternName).toBeUndefined();
  });

  test("Bash 但 command 非字符串 → 跳过 DENY，走后续流程", () => {
    const result = evalInput({
      toolName: "Bash",
      requiresApproval: true,
      input: { command: 123 },
    });
    expect(result.decision).toBe("ask");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 2: bypassPermissions
// ────────────────────────────────────────────────────────────────────────────
describe("Step 2: bypassPermissions", () => {
  test("bypass → FileWrite 无视 requiresApproval 放行", () => {
    const result = evalInput({
      mode: "bypassPermissions",
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "a.ts" },
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("bypassPermissions mode");
  });

  test("bypass → Bash 安全命令放行", () => {
    const result = evalInput({
      mode: "bypassPermissions",
      toolName: "Bash",
      input: { command: "ls -la" },
    });
    expect(result.decision).toBe("allow");
  });

  test("bypass → project deny 规则也被绕过（仅次于 DENY_PATTERNS）", () => {
    // 这是有意的语义：bypass 就是"全部放行"，规则层统统不生效
    const result = evalInput({
      mode: "bypassPermissions",
      toolName: "Bash",
      input: { command: "git status" },
      rules: [mkEntry("project", "Bash", "deny", "git:*")],
    });
    expect(result.decision).toBe("allow");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 3: deny 规则
// ────────────────────────────────────────────────────────────────────────────
describe("Step 3: deny 规则", () => {
  test("session deny 命中 → deny", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git push" },
      rules: [mkEntry("session", "Bash", "deny", "git push:*")],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.source).toBe("session");
  });

  test("project deny 命中 → deny", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git push origin main" },
      rules: [mkEntry("project", "Bash", "deny", "git push:*")],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.source).toBe("project");
  });

  test("global deny 命中 → deny（任一层都最高优先级）", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git push" },
      rules: [mkEntry("global", "Bash", "deny", "git push:*")],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.source).toBe("global");
  });

  test("deny 比同级 allow 先生效（两条同形）", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git push" },
      rules: [
        mkEntry("session", "Bash", "allow", "git:*"),
        mkEntry("session", "Bash", "deny", "git push:*"),
      ],
    });
    expect(result.decision).toBe("deny");
  });

  test("deny 不匹配 → 不生效，继续后续步", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git status" },
      rules: [mkEntry("session", "Bash", "deny", "git push:*")],
      requiresApproval: true,
    });
    expect(result.decision).toBe("ask");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 4: allow / ask 规则
// ────────────────────────────────────────────────────────────────────────────
describe("Step 4: allow / ask 规则 source 优先级", () => {
  test("session allow 优先于 project ask（同形）", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git status" },
      rules: [
        mkEntry("project", "Bash", "ask", "git:*"),
        mkEntry("session", "Bash", "allow", "git:*"),
      ],
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedRule?.source).toBe("session");
  });

  test("project ask 优先于 global allow", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git status" },
      rules: [
        mkEntry("global", "Bash", "allow", "git:*"),
        mkEntry("project", "Bash", "ask", "git:*"),
      ],
    });
    expect(result.decision).toBe("ask");
    expect(result.matchedRule?.source).toBe("project");
  });

  test("只有 global allow → 放行", () => {
    const result = evalInput({
      toolName: "Bash",
      input: { command: "git status" },
      rules: [mkEntry("global", "Bash", "allow", "git:*")],
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedRule?.source).toBe("global");
  });

  test("ask 规则能覆盖 requiresApproval=false（只读工具强制询问）", () => {
    const result = evalInput({
      toolName: "FileRead",
      requiresApproval: false,
      rules: [mkEntry("session", "FileRead", "ask")],
    });
    expect(result.decision).toBe("ask");
  });
});

describe("Step 4: 规则匹配粒度", () => {
  test("FileWrite 规则 path 匹配", () => {
    const result = evalInput({
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "src/foo.ts" },
      rules: [mkEntry("session", "FileWrite", "allow", "src/**/*.ts")],
    });
    expect(result.decision).toBe("allow");
  });

  test("FileWrite 规则 path 不匹配 → 继续走 requiresApproval", () => {
    const result = evalInput({
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "docs/a.md" },
      rules: [mkEntry("session", "FileWrite", "allow", "src/**/*.ts")],
    });
    expect(result.decision).toBe("ask");
  });

  test("工具名不同的规则被忽略", () => {
    const result = evalInput({
      toolName: "Bash",
      requiresApproval: true,
      input: { command: "ls" },
      rules: [mkEntry("session", "FileWrite", "allow", "**/*")],
    });
    expect(result.decision).toBe("ask");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 5: acceptEdits mode
// ────────────────────────────────────────────────────────────────────────────
describe("Step 5: acceptEdits mode", () => {
  test("acceptEdits + FileWrite → allow", () => {
    const result = evalInput({
      mode: "acceptEdits",
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "a.ts" },
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("acceptEdits");
  });

  test("acceptEdits + FileEdit → allow", () => {
    const result = evalInput({
      mode: "acceptEdits",
      toolName: "FileEdit",
      requiresApproval: true,
      input: { path: "a.ts" },
    });
    expect(result.decision).toBe("allow");
  });

  test("acceptEdits + Bash → 仍走 ask（acceptEdits 不放 Bash）", () => {
    const result = evalInput({
      mode: "acceptEdits",
      toolName: "Bash",
      requiresApproval: true,
      input: { command: "ls" },
    });
    expect(result.decision).toBe("ask");
  });

  test("acceptEdits 不能越过 deny 规则", () => {
    const result = evalInput({
      mode: "acceptEdits",
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "secret.key" },
      rules: [mkEntry("project", "FileWrite", "deny", "*.key")],
    });
    expect(result.decision).toBe("deny");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 6 / 7: requiresApproval 与默认
// ────────────────────────────────────────────────────────────────────────────
describe("Step 6 / 7: 兜底", () => {
  test("requiresApproval=true + default mode + 无规则 → ask", () => {
    const result = evalInput({
      toolName: "Bash",
      requiresApproval: true,
      input: { command: "ls" },
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("tool requires approval");
  });

  test("requiresApproval=false + 无规则 → allow（只读工具）", () => {
    const result = evalInput({ toolName: "GrepTool", requiresApproval: false });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("read-only");
  });

  test("未知工具 + 空规则 + requiresApproval=false → allow", () => {
    const result = evalInput({ toolName: "CustomMCPTool" });
    expect(result.decision).toBe("allow");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 组合场景
// ────────────────────────────────────────────────────────────────────────────
describe("组合场景", () => {
  test("真实场景：session allow 'git:*' 让所有 git 子命令放行", () => {
    const rules = [mkEntry("session", "Bash", "allow", "git:*")];
    for (const cmd of ["git status", "git diff", "git log --oneline"]) {
      expect(evalInput({ toolName: "Bash", input: { command: cmd }, rules }).decision).toBe(
        "allow",
      );
    }
  });

  test("真实场景：session allow 'git:*' + project deny 'git push:*'", () => {
    const rules = [
      mkEntry("session", "Bash", "allow", "git:*"),
      mkEntry("project", "Bash", "deny", "git push:*"),
    ];
    expect(evalInput({ toolName: "Bash", input: { command: "git status" }, rules }).decision).toBe(
      "allow",
    );
    expect(
      evalInput({ toolName: "Bash", input: { command: "git push origin main" }, rules }).decision,
    ).toBe("deny");
  });

  test("FileWrite 绝对路径 + session allow 相对 glob", () => {
    const result = evalInput({
      toolName: "FileWrite",
      requiresApproval: true,
      input: { path: "/work/src/foo.ts" },
      cwd: "/work",
      rules: [mkEntry("session", "FileWrite", "allow", "src/**/*.ts")],
    });
    expect(result.decision).toBe("allow");
  });
});
