/**
 * /compact 斜杠命令单测。
 *
 * - chatRuntime 未注入 → 友好提示 + continue
 * - chatRuntime 注入 + session.compact 成功 → 打印进度行
 * - session.compact 抛错 → 打印错误行 + continue（REPL 不退出）
 * - args 拼成 customInstructions 透传给 session.compact
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedConfig } from "../../../config/config.ts";
import type { NovaMessage } from "../../../types/message.ts";
import { ChatSession, type SessionMeta } from "../ChatSession.ts";
import { compactCommand } from "./compact.ts";
import type { SlashContext, SlashIO } from "./types.ts";

const META: SessionMeta = {
  sessionId: "compact-test",
  model: "claude-test",
  createdAt: "2026-05-12T00:00:00.000Z",
};
const CONFIG: ResolvedConfig = {
  apiKey: "sk-test",
  baseURL: undefined,
  model: "claude-test",
  maxTokens: 1024,
  maxTurns: 5,
  webProxy: undefined,
  webProxyDomains: [],
  mcpServers: {},
};

function makeIO(): SlashIO & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    print: (text) => written.push(text),
    confirm: async () => false,
  };
}

function makeCtx(overrides: Partial<SlashContext> & { io: SlashIO }): SlashContext {
  return {
    session: overrides.session ?? new ChatSession(META),
    io: overrides.io,
    args: overrides.args ?? [],
    ...(overrides.chatRuntime ? { chatRuntime: overrides.chatRuntime } : {}),
  };
}

describe("compactCommand", () => {
  test("chatRuntime 未注入 → 提示 + continue", async () => {
    const io = makeIO();
    const result = await compactCommand.run(makeCtx({ io }));
    expect(result.action).toBe("continue");
    expect(io.written.join("")).toContain("无法执行 /compact");
  });

  test("成功路径 → 打印进度行（含 token 数）", async () => {
    const io = makeIO();
    // 用 spy-session 替代真 ChatSession，避免触发真实 createAnthropicClient
    const fakeSession = {
      compact: async () => ({
        preCompactTokenCount: 1500,
        postCompactTokenCount: 200,
        compactedMessages: 8,
      }),
      meta: META,
      snapshot: () => [] as readonly NovaMessage[],
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any;
    const result = await compactCommand.run({
      session: fakeSession,
      io,
      args: [],
      chatRuntime: {
        config: CONFIG,
        signal: new AbortController().signal,
      },
    });
    expect(result.action).toBe("continue");
    const out = io.written.join("");
    expect(out).toContain("已压缩 8 条消息");
    expect(out).toContain("1500 → 200 tokens");
  });

  test("session.compact 抛错 → 打印错误 + continue", async () => {
    const io = makeIO();
    // session 空 messages → ChatSession.compact 抛 "No messages to compact yet."
    const session = new ChatSession(META);
    const result = await compactCommand.run(
      makeCtx({
        io,
        session,
        chatRuntime: {
          config: CONFIG,
          signal: new AbortController().signal,
        },
      }),
    );
    expect(result.action).toBe("continue");
    expect(io.written.join("")).toContain("/compact 失败");
    expect(io.written.join("")).toContain("No messages to compact");
  });

  test("args 拼成 customInstructions 传给 session.compact", async () => {
    const io = makeIO();
    // 空 session 路径仍会抛错，但我们能侧面验证：用 spy session 检查参数
    let capturedArgs: unknown;
    const fakeSession = {
      compact: async (_ctx: unknown, ci?: string) => {
        capturedArgs = ci;
        throw new Error("test stop");
      },
      // satisfy ChatSession 的鸭子接口（类型断言）
      meta: META,
      snapshot: () => [] as readonly NovaMessage[],
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any;
    await compactCommand.run({
      session: fakeSession,
      io,
      args: ["focus", "on", "tests"],
      chatRuntime: {
        config: CONFIG,
        signal: new AbortController().signal,
      },
    });
    expect(capturedArgs).toBe("focus on tests");
  });
});
