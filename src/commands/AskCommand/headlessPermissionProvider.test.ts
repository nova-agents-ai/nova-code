/**
 * headlessPermissionProvider 单测。
 *
 * 断言要点：
 *   - 所有请求（Bash / FileWrite / FileEdit / 随意工具名）一律返回 "deny"
 *   - stderr 被调用一次，消息包含 toolName 和 reason
 *   - 不抛、不阻塞
 */

import { describe, expect, test } from "bun:test";

import type { PermissionRequest } from "../../services/permissions/PermissionProvider.ts";
import { createHeadlessPermissionProvider } from "./headlessPermissionProvider.ts";

function makeReq(partial: Partial<PermissionRequest>): PermissionRequest {
  return {
    toolName: partial.toolName ?? "Bash",
    toolUseId: partial.toolUseId ?? "tu_test",
    input: partial.input ?? { command: "ls" },
    reason: partial.reason ?? "requiresApproval 返回 true",
  };
}

describe("createHeadlessPermissionProvider", () => {
  test("Bash 请求 → deny，并写一行 stderr", async () => {
    const stderrCalls: string[] = [];
    const provider = createHeadlessPermissionProvider({
      stderr: (t) => stderrCalls.push(t),
    });

    const choice = await provider.requestPermission(
      makeReq({ toolName: "Bash", reason: "unsafe cmd" }),
    );

    expect(choice).toBe("deny");
    expect(stderrCalls).toHaveLength(1);
    const line = stderrCalls[0];
    expect(line).toBeDefined();
    expect(line).toContain("headless mode auto-deny");
    expect(line).toContain("Bash");
    expect(line).toContain("unsafe cmd");
  });

  test("FileWrite 请求 → deny", async () => {
    const stderrCalls: string[] = [];
    const provider = createHeadlessPermissionProvider({
      stderr: (t) => stderrCalls.push(t),
    });

    const choice = await provider.requestPermission(
      makeReq({
        toolName: "FileWrite",
        input: { file_path: "/tmp/x", content: "hi" },
        reason: "no matching rule",
      }),
    );

    expect(choice).toBe("deny");
    expect(stderrCalls[0]).toContain("FileWrite");
  });

  test("FileEdit 请求 → deny", async () => {
    const stderrCalls: string[] = [];
    const provider = createHeadlessPermissionProvider({
      stderr: (t) => stderrCalls.push(t),
    });

    const choice = await provider.requestPermission(makeReq({ toolName: "FileEdit" }));

    expect(choice).toBe("deny");
  });

  test("未知工具 → deny，消息包含工具名", async () => {
    const stderrCalls: string[] = [];
    const provider = createHeadlessPermissionProvider({
      stderr: (t) => stderrCalls.push(t),
    });

    const choice = await provider.requestPermission(
      makeReq({ toolName: "MyCustomTool", reason: "unknown tool" }),
    );

    expect(choice).toBe("deny");
    expect(stderrCalls[0]).toContain("MyCustomTool");
  });

  test("连续多次调用：每次都 deny，都写一行 stderr", async () => {
    const stderrCalls: string[] = [];
    const provider = createHeadlessPermissionProvider({
      stderr: (t) => stderrCalls.push(t),
    });

    const c1 = await provider.requestPermission(makeReq({ toolName: "Bash" }));
    const c2 = await provider.requestPermission(makeReq({ toolName: "FileWrite" }));
    const c3 = await provider.requestPermission(makeReq({ toolName: "FileEdit" }));

    expect(c1).toBe("deny");
    expect(c2).toBe("deny");
    expect(c3).toBe("deny");
    expect(stderrCalls).toHaveLength(3);
  });
});
