/**
 * commands.ts 的单元测试。
 *
 * 直接调用 CommandDefinition.run，绕开 CLI 主流程，专注命令本身的边界。
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { buildDebugLogFileName, builtinCommands, findCommand } from "./commands.ts";

interface OutputCapture {
  log: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  output: () => string;
  errorOutput: () => string;
}

let capture: OutputCapture;
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  originalLog = console.log;
  originalError = console.error;

  const logChunks: string[] = [];
  const errorChunks: string[] = [];

  const logMock = mock((...args: unknown[]) => {
    logChunks.push(args.map(String).join(" "));
  });
  const errorMock = mock((...args: unknown[]) => {
    errorChunks.push(args.map(String).join(" "));
  });

  console.log = logMock;
  console.error = errorMock;

  capture = {
    log: logMock,
    error: errorMock,
    output: () => logChunks.join("\n"),
    errorOutput: () => errorChunks.join("\n"),
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("findCommand", () => {
  test("能找到所有内置命令", () => {
    expect(findCommand("hello")?.name).toBe("hello");
    expect(findCommand("ask")?.name).toBe("ask");
    expect(findCommand("cost")?.name).toBe("cost");
    expect(findCommand("config")?.name).toBe("config");
    expect(findCommand("init")?.name).toBe("init");
  });

  test("找不到时返回 undefined", () => {
    expect(findCommand("nope")).toBeUndefined();
    expect(findCommand("")).toBeUndefined();
  });

  test("命令名严格区分大小写", () => {
    expect(findCommand("Hello")).toBeUndefined();
    expect(findCommand("HELLO")).toBeUndefined();
  });
});

describe("builtinCommands 元数据完备性", () => {
  test("每个命令都包含 name / description / usage / run", () => {
    for (const command of builtinCommands) {
      expect(command.name).toBeTruthy();
      expect(command.description).toBeTruthy();
      expect(command.usage).toBeTruthy();
      expect(typeof command.run).toBe("function");
    }
  });

  test("命令名互不重复", () => {
    const names = builtinCommands.map((command) => command.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("每个命令的 usage 都以 nova-code 开头", () => {
    for (const command of builtinCommands) {
      expect(command.usage.startsWith("nova-code ")).toBe(true);
    }
  });

  test("每个命令的 usage 都包含自己的 name", () => {
    for (const command of builtinCommands) {
      expect(command.usage).toContain(command.name);
    }
  });
});

describe("hello 命令", () => {
  const hello = findCommand("hello");

  test("命令存在", () => {
    expect(hello).toBeDefined();
  });

  test("无参数时打招呼对象为 world", async () => {
    const exitCode = await hello?.run([]);
    expect(exitCode).toBe(0);
    expect(capture.output()).toBe("Hello, world!");
  });

  test("传入姓名时打招呼对象为该姓名", async () => {
    const exitCode = await hello?.run(["alice"]);
    expect(exitCode).toBe(0);
    expect(capture.output()).toBe("Hello, alice!");
  });

  test("空字符串姓名按 fallback 处理（?? 仅对 undefined/null 生效）", async () => {
    // 注意：?? 不会把空字符串当成 nullish，所以打招呼对象就是空字符串本身。
    const exitCode = await hello?.run([""]);
    expect(exitCode).toBe(0);
    expect(capture.output()).toBe("Hello, !");
  });
});

describe("ask 命令", () => {
  const ask = findCommand("ask");

  test("命令存在", () => {
    expect(ask).toBeDefined();
  });

  // ask 涉及真实 stdin 交互，本套件只校验命令注册是否正确，不做端到端 IO 测试。
  // 端到端 IO 测试应通过 spawn 子进程并喂 stdin 实现，属于集成测试范畴。
  test("usage 描述包含 ask 命令名", () => {
    expect(ask?.usage).toContain("nova-code ask");
  });

  test("usage 中说明了 --debug flag", () => {
    expect(ask?.usage).toContain("--debug");
  });

  test("usage 中提示日志文件落在 ~/.nova-code/logs/", () => {
    expect(ask?.usage).toContain("~/.nova-code/logs/");
  });
});

describe("buildDebugLogFileName", () => {
  test("按 ask-YYYY-MM-DDTHH-mm-ss-<pid>.log 格式生成", () => {
    // 月份 0-indexed：4 → 5 月
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const name = buildDebugLogFileName(fixedDate, 42649);
    expect(name).toBe("ask-2026-05-01T15-11-23-42649.log");
  });

  test("个位数月/日/时/分/秒补零", () => {
    const fixedDate = new Date(2026, 0, 2, 3, 4, 5);
    const name = buildDebugLogFileName(fixedDate, 1);
    expect(name).toBe("ask-2026-01-02T03-04-05-1.log");
  });

  test("文件名按字典序与时序一致（便于 ls -lt 排序）", () => {
    const earlier = buildDebugLogFileName(new Date(2026, 4, 1, 10, 0, 0), 1);
    const later = buildDebugLogFileName(new Date(2026, 4, 1, 10, 0, 1), 1);
    expect(earlier < later).toBe(true);
  });

  test("传入 sessionId 时文件名后缀使用 sessionId 替代 pid", () => {
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const name = buildDebugLogFileName(fixedDate, 42649, "sess-abc123");
    expect(name).toBe("ask-2026-05-01T15-11-23-sess-abc123.log");
  });

  test("空字符串 sessionId 也会被采用（调用方负责自行校验）", () => {
    // 约定：调用方传了值就是调用方的意图；undefined 才回落 pid。
    // 空字符串形成不合理的文件名，但是入参的责任由调用方满足。
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const name = buildDebugLogFileName(fixedDate, 42649, "");
    expect(name).toBe("ask-2026-05-01T15-11-23-.log");
  });

  test("不传 sessionId 时保持 pid 后缀（向后兼容）", () => {
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const withoutSession = buildDebugLogFileName(fixedDate, 42649);
    const withUndefined = buildDebugLogFileName(fixedDate, 42649, undefined);
    expect(withoutSession).toBe("ask-2026-05-01T15-11-23-42649.log");
    expect(withUndefined).toBe(withoutSession);
  });

  test('传 prefix="chat" 时文件名以 chat- 开头（M2 chat REPL）', () => {
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const name = buildDebugLogFileName(fixedDate, 42649, "sess-abc123", "chat");
    expect(name).toBe("chat-2026-05-01T15-11-23-sess-abc123.log");
  });

  test('prefix 默认值仍是 "ask"（显式传 undefined 等价不传）', () => {
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const defaulted = buildDebugLogFileName(fixedDate, 42649, undefined, undefined);
    expect(defaulted).toBe("ask-2026-05-01T15-11-23-42649.log");
  });

  test("只传 prefix 不传 sessionId：文件名仍以 pid 收尾", () => {
    const fixedDate = new Date(2026, 4, 1, 15, 11, 23);
    const name = buildDebugLogFileName(fixedDate, 42649, undefined, "chat");
    expect(name).toBe("chat-2026-05-01T15-11-23-42649.log");
  });
});
