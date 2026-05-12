/**
 * replPermissionProvider 的单元测试。
 *
 * 覆盖点：
 * - 输入 "1" → allow-once；"2"..."4" → 对应 allow-always-*；"5" / 空行 / EOF → deny
 * - 无效输入循环提示，直到拿到合法选择
 * - 菜单 + header 被写进 io.stderr，且 header 带工具名 + input 摘要 + reason
 * - Bash 工具摘要是 `\`command\``；FileWrite/FileEdit 是 file_path；其它走 JSON.stringify
 */

import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../../services/permissions/PermissionProvider.ts";
import type { UserChoice } from "../../types/permissions.ts";
import { createReplPermissionProvider } from "./replPermissionProvider.ts";

function makeIO(): {
  readonly io: { stdout: (t: string) => void; stderr: (t: string) => void };
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    },
    out,
    err,
  };
}

function makeReadLine(scripted: readonly (string | null)[]): {
  readonly readLine: (prompt: string) => Promise<string | null>;
  readonly prompts: string[];
} {
  let idx = 0;
  const prompts: string[] = [];
  return {
    prompts,
    readLine: (prompt) => {
      prompts.push(prompt);
      const value = scripted[idx];
      idx += 1;
      return Promise.resolve(value ?? null);
    },
  };
}

const bashRequest: PermissionRequest = {
  toolName: "Bash",
  toolUseId: "tu_1",
  input: { command: "git push --force" },
  reason: "tool requires approval",
};

describe("createReplPermissionProvider - 选择映射", () => {
  async function runWith(inputs: readonly string[]): Promise<{
    readonly choice: UserChoice;
    readonly err: string[];
  }> {
    const { io, err } = makeIO();
    const { readLine } = makeReadLine(inputs);
    const provider = createReplPermissionProvider({ io, readLine });
    const choice = await provider.requestPermission(bashRequest);
    return { choice, err };
  }

  test("'1' → allow-once", async () => {
    const { choice } = await runWith(["1"]);
    expect(choice).toBe("allow-once");
  });

  test("'2' → allow-always-session", async () => {
    const { choice } = await runWith(["2"]);
    expect(choice).toBe("allow-always-session");
  });

  test("'3' → allow-always-project", async () => {
    const { choice } = await runWith(["3"]);
    expect(choice).toBe("allow-always-project");
  });

  test("'4' → allow-always-global", async () => {
    const { choice } = await runWith(["4"]);
    expect(choice).toBe("allow-always-global");
  });

  test("'5' → deny", async () => {
    const { choice } = await runWith(["5"]);
    expect(choice).toBe("deny");
  });

  test("空行 → deny（安全从严）", async () => {
    const { choice } = await runWith([""]);
    expect(choice).toBe("deny");
  });

  test("空白字符会被 trim → deny", async () => {
    const { choice } = await runWith(["   "]);
    expect(choice).toBe("deny");
  });

  test("回车后 trim 出的 '1' → allow-once", async () => {
    const { choice } = await runWith([" 1 "]);
    expect(choice).toBe("allow-once");
  });

  test("无效输入先提示，再接受下一次合法输入", async () => {
    const { io, err } = makeIO();
    const { readLine, prompts } = makeReadLine(["foo", "bar", "2"]);
    const provider = createReplPermissionProvider({ io, readLine });
    const choice = await provider.requestPermission(bashRequest);
    expect(choice).toBe("allow-always-session");
    // "foo" / "bar" 都非法 → 2 条警告；第 3 次 "2" 合法
    expect(prompts.length).toBe(3);
    const warnings = err.filter((line) => line.includes("无效输入"));
    expect(warnings.length).toBe(2);
  });

  test("readLine 返回 null（EOF）→ deny", async () => {
    const { io } = makeIO();
    const { readLine } = makeReadLine([null]);
    const provider = createReplPermissionProvider({ io, readLine });
    const choice = await provider.requestPermission(bashRequest);
    expect(choice).toBe("deny");
  });
});

describe("createReplPermissionProvider - 菜单与 header", () => {
  test("header 行含 toolName / input 摘要 / reason", async () => {
    const { io, err } = makeIO();
    const { readLine } = makeReadLine(["1"]);
    const provider = createReplPermissionProvider({ io, readLine });
    await provider.requestPermission(bashRequest);

    const header = err.find((line) => line.includes("[permission]"));
    expect(header).toBeDefined();
    expect(header).toContain("Bash");
    expect(header).toContain("git push --force");
    expect(header).toContain("tool requires approval");
  });

  test("菜单 5 项全部写入 stderr", async () => {
    const { io, err } = makeIO();
    const { readLine } = makeReadLine(["1"]);
    const provider = createReplPermissionProvider({ io, readLine });
    await provider.requestPermission(bashRequest);
    const combined = err.join("");
    expect(combined).toContain("1) allow once");
    expect(combined).toContain("2) allow always (session)");
    expect(combined).toContain("3) allow always (project)");
    expect(combined).toContain("4) allow always (global)");
    expect(combined).toContain("5) deny");
  });

  test("FileWrite 的摘要是 file_path", async () => {
    const { io, err } = makeIO();
    const { readLine } = makeReadLine(["1"]);
    const provider = createReplPermissionProvider({ io, readLine });
    await provider.requestPermission({
      toolName: "FileWrite",
      toolUseId: "tu_2",
      input: { file_path: "/tmp/x.ts" },
      reason: "user ask rule",
    });
    const header = err.find((line) => line.includes("[permission]"));
    expect(header).toContain("FileWrite");
    expect(header).toContain("/tmp/x.ts");
  });

  test("未知工具的摘要走 JSON.stringify", async () => {
    const { io, err } = makeIO();
    const { readLine } = makeReadLine(["1"]);
    const provider = createReplPermissionProvider({ io, readLine });
    await provider.requestPermission({
      toolName: "UnknownTool",
      toolUseId: "tu_3",
      input: { a: 1, b: "x" },
      reason: "test",
    });
    const header = err.find((line) => line.includes("[permission]"));
    expect(header).toContain("UnknownTool");
    expect(header).toContain('{"a":1,"b":"x"}');
  });
});
