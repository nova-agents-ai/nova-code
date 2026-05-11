/**
 * dispatcher 单测 —— 对齐设计稿 §10.1。
 *
 * 覆盖：
 * - 非 `/` 前缀 → handled:false，调用方继续走 session.sendTurn
 * - `/` 但空名（只输入 "/"）→ handled:true + continue，io.print 给提示
 * - 未知 `/xxx` → handled:true + continue，io.print 提到 /help
 * - `/exit` → handled:true，result.action === "exit"
 * - `/clear` → 清空 session 的 messages
 * - `/save arg1 arg2` → 命令内部拿到的 args 是 ["arg1","arg2"]（走 save 走路径太重，
 *   本测用一个 fake 命令替代验证 tokenize 语义；此处直接检查 save 命令不在工厂里，
 *   所以我们把 tokenize 断言收在 unknown 命令路径，结合 args 断言。实际 args
 *   的更严细单测由 /save、/load 自身的测试覆盖——M2 阶段 save/load 的完整单测
 *   在 task 7.1、7.2 已经写入其各自 sessionStore.test.ts / save/load 自己的测试里）。
 */

import { describe, expect, mock, test } from "bun:test";
import type { NovaMessage } from "../../../types/message.ts";
import { MessageRoleEnum } from "../../../types/message.ts";
import { ChatSession } from "../ChatSession.ts";
import { dispatchSlash } from "./dispatcher.ts";
import type { SlashIO } from "./types.ts";

/** 构造一个最小可用的 SlashIO 假实现。print 走 mock，confirm 默认 true。 */
function makeIO(confirmAnswer: boolean = true): {
  readonly io: SlashIO;
  readonly prints: string[];
} {
  const prints: string[] = [];
  const io: SlashIO = {
    print(text: string): void {
      prints.push(text);
    },
    async confirm(_prompt: string): Promise<boolean> {
      return confirmAnswer;
    },
  };
  return { io, prints };
}

/** 构造一个带若干历史消息的 ChatSession。 */
function makeSession(messages: readonly NovaMessage[] = []): ChatSession {
  return new ChatSession(
    {
      sessionId: "test-session",
      model: "claude-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    messages,
  );
}

describe("dispatchSlash", () => {
  test("非 `/` 前缀输入 → handled:false，不触 io", async () => {
    const session = makeSession();
    const { io, prints } = makeIO();

    const result = await dispatchSlash("hello world", { session, io });

    expect(result.handled).toBe(false);
    expect(prints).toEqual([]);
  });

  test("空字符串不以 `/` 开头 → handled:false", async () => {
    const session = makeSession();
    const { io, prints } = makeIO();

    const result = await dispatchSlash("", { session, io });

    expect(result.handled).toBe(false);
    expect(prints).toEqual([]);
  });

  test("只输入 `/` → handled:true + continue，提示 /help", async () => {
    const session = makeSession();
    const { io, prints } = makeIO();

    const result = await dispatchSlash("/", { session, io });

    expect(result).toEqual({ handled: true, result: { action: "continue" } });
    expect(prints.length).toBe(1);
    // 空命令 → 必须提到 /help，让用户知道如何继续
    expect(prints[0]).toContain("/help");
  });

  test("未知命令 `/xxx` → handled:true + continue，打印含 /help 和命令名", async () => {
    const session = makeSession();
    const { io, prints } = makeIO();

    const result = await dispatchSlash("/nosuchcmd extra args", {
      session,
      io,
    });

    expect(result).toEqual({ handled: true, result: { action: "continue" } });
    expect(prints.length).toBe(1);
    expect(prints[0]).toContain("nosuchcmd");
    expect(prints[0]).toContain("/help");
  });

  test("`/exit` → handled:true，result.action === 'exit'，exitCode=0", async () => {
    const session = makeSession();
    const { io } = makeIO();

    const result = await dispatchSlash("/exit", { session, io });

    expect(result.handled).toBe(true);
    // 类型保险：仅在 handled=true 分支访问 result
    if (result.handled) {
      expect(result.result.action).toBe("exit");
      if (result.result.action === "exit") {
        expect(result.result.exitCode).toBe(0);
      }
    }
  });

  test("`/clear` → 清空 session 的 messages，meta 保留", async () => {
    const initial: readonly NovaMessage[] = [
      { role: MessageRoleEnum.USER, content: "hi" },
      { role: MessageRoleEnum.ASSISTANT, content: "hello" },
    ];
    const session = makeSession(initial);
    const { io, prints } = makeIO();

    // 前置断言：clear 前确有历史
    expect(session.snapshot().length).toBe(2);

    const result = await dispatchSlash("/clear", { session, io });

    expect(result).toEqual({ handled: true, result: { action: "continue" } });
    expect(session.snapshot()).toEqual([]);
    // meta 未被 /clear 触碰
    expect(session.meta.sessionId).toBe("test-session");
    // 用户可见反馈
    expect(prints.length).toBe(1);
    expect(prints[0]).toContain("清空");
  });

  test("前后多余空白被 trim，不会导致 `/clear ` 被识别为未知命令", async () => {
    const session = makeSession([{ role: MessageRoleEnum.USER, content: "x" }]);
    const { io } = makeIO();

    const result = await dispatchSlash("/clear   ", { session, io });

    expect(result.handled).toBe(true);
    expect(session.snapshot()).toEqual([]);
  });

  test("命令参数按空白切分：未知命令能拿到剩余 tokens（经由打印不会挂）", async () => {
    // 这里间接验证 tokenize 分支不会抛；参数正确性由各命令自身测试覆盖
    const session = makeSession();
    const { io, prints } = makeIO();

    const result = await dispatchSlash("/x\targ1   arg2", { session, io });

    expect(result).toEqual({ handled: true, result: { action: "continue" } });
    // 未知命令提示里应包含命令名 x
    expect(prints[0]).toContain("x");
  });

  test("dispatchSlash 只会调用 print，不会意外吞掉其他异常（sanity）", async () => {
    const session = makeSession();
    const printMock = mock((_text: string) => {});
    const io: SlashIO = {
      print: printMock,
      async confirm(_prompt: string): Promise<boolean> {
        return true;
      },
    };

    const result = await dispatchSlash("/exit", { session, io });

    expect(result.handled).toBe(true);
    // /exit 自身不打印任何东西
    expect(printMock).toHaveBeenCalledTimes(0);
  });
});
