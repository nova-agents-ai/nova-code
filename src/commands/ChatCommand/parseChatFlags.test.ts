/**
 * parseChatFlags 单测 —— 覆盖 --debug / --debug-pretty / --resume 的全部分支。
 */

import { describe, expect, test } from "bun:test";

import { ChatFlagsError, parseChatFlags } from "./parseChatFlags.ts";

describe("parseChatFlags", () => {
  test("空参数 → 全 false，resumeId undefined", () => {
    const flags = parseChatFlags([]);
    expect(flags.debug).toBe(false);
    expect(flags.pretty).toBe(false);
    expect(flags.resumeId).toBeUndefined();
    expect(flags.rest).toEqual([]);
  });

  test("--debug → debug=true, pretty=false", () => {
    const flags = parseChatFlags(["--debug"]);
    expect(flags.debug).toBe(true);
    expect(flags.pretty).toBe(false);
  });

  test("--debug-pretty 隐含 --debug", () => {
    const flags = parseChatFlags(["--debug-pretty"]);
    expect(flags.debug).toBe(true);
    expect(flags.pretty).toBe(true);
  });

  test("--resume <id> → resumeId 读取下一个 token", () => {
    const flags = parseChatFlags(["--resume", "abc-123"]);
    expect(flags.resumeId).toBe("abc-123");
  });

  test("--resume=<id> 简写同样生效", () => {
    const flags = parseChatFlags(["--resume=alias-a"]);
    expect(flags.resumeId).toBe("alias-a");
  });

  test("--resume 缺参数 → 抛 ChatFlagsError", () => {
    expect(() => parseChatFlags(["--resume"])).toThrow(ChatFlagsError);
  });

  test("--resume 后紧跟另一个 --xxx → 拒绝", () => {
    expect(() => parseChatFlags(["--resume", "--debug"])).toThrow(ChatFlagsError);
  });

  test("--resume= 空值 → 抛", () => {
    expect(() => parseChatFlags(["--resume="])).toThrow(ChatFlagsError);
  });

  test("混合组合：--debug --resume x --debug-pretty", () => {
    const flags = parseChatFlags(["--debug", "--resume", "x", "--debug-pretty"]);
    expect(flags.debug).toBe(true);
    expect(flags.pretty).toBe(true);
    expect(flags.resumeId).toBe("x");
  });

  test("位置参数 → 抛 ChatFlagsError", () => {
    expect(() => parseChatFlags(["hello"])).toThrow(ChatFlagsError);
  });
});
