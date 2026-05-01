/**
 * commands.ts 的单元测试。
 *
 * 直接调用 CommandDefinition.run，绕开 CLI 主流程，专注命令本身的边界。
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { builtinCommands, findCommand } from "./commands.ts";

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
    expect(findCommand("echo")?.name).toBe("echo");
    expect(findCommand("ask")?.name).toBe("ask");
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

describe("echo 命令", () => {
  const echo = findCommand("echo");

  test("命令存在", () => {
    expect(echo).toBeDefined();
  });

  test("空参数时返回 1 并打印错误", async () => {
    const exitCode = await echo?.run([]);
    expect(exitCode).toBe(1);
    expect(capture.errorOutput()).toContain("至少需要一个参数");
    expect(capture.log).not.toHaveBeenCalled();
  });

  test("单参数原样返回", async () => {
    const exitCode = await echo?.run(["hello"]);
    expect(exitCode).toBe(0);
    expect(capture.output()).toBe("hello");
  });

  test("多参数空格连接", async () => {
    const exitCode = await echo?.run(["a", "b", "c"]);
    expect(exitCode).toBe(0);
    expect(capture.output()).toBe("a b c");
  });

  test("保留特殊字符（含中文/标点）", async () => {
    const exitCode = await echo?.run(["你好", "世界！"]);
    expect(exitCode).toBe(0);
    expect(capture.output()).toBe("你好 世界！");
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
});
