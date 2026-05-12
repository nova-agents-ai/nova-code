/**
 * runCli 主流程的单元测试。
 *
 * 测试策略：
 * - runCli 通过 console.log / console.error 与外部交互；用 spyOn 拦截后断言。
 * - 不通过 spawn 子进程的方式测，而是直接调用函数，速度快且能覆盖所有分支。
 * - 不测 ask 命令（依赖真实 stdin），相关边界放在 commands.test.ts 单独处理。
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { runCli } from "./cli.ts";
import { findCommand } from "./commands.ts";

interface Spies {
  log: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  output: () => string;
  errorOutput: () => string;
}

let spies: Spies;
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

  spies = {
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

describe("runCli - 顶层选项", () => {
  test("无参数时打印 help 并返回 0", async () => {
    const exitCode = await runCli({ argv: [] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toContain("nova-code v");
    expect(spies.output()).toContain("用法:");
    expect(spies.output()).toContain("可用命令:");
  });

  test("--help 打印 help 并返回 0", async () => {
    const exitCode = await runCli({ argv: ["--help"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toContain("用法:");
  });

  test("-h 等价于 --help", async () => {
    const exitCode = await runCli({ argv: ["-h"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toContain("用法:");
  });

  test("--version 打印默认版本号并返回 0", async () => {
    const exitCode = await runCli({ argv: ["--version"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toMatch(/^nova-code v\d+\.\d+\.\d+/);
  });

  test("-v 等价于 --version", async () => {
    const exitCode = await runCli({ argv: ["-v"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toMatch(/^nova-code v\d+\.\d+\.\d+/);
  });

  test("help 输出包含所有内置命令", async () => {
    await runCli({ argv: ["--help"] });

    const output = spies.output();
    expect(output).toContain("hello");
    expect(output).toContain("echo");
    expect(output).toContain("ask");
  });
});

describe("runCli - 自定义元信息", () => {
  test("注入 name/version/description 后 help 与 version 都用注入值", async () => {
    await runCli({
      argv: ["--version"],
      name: "my-app",
      version: "9.9.9",
      description: "我的自定义工具",
    });

    expect(spies.output()).toBe("my-app v9.9.9");
  });

  test("注入 name 后未知命令的提示也使用注入名", async () => {
    const exitCode = await runCli({
      argv: ["nope"],
      name: "my-app",
    });

    expect(exitCode).toBe(1);
    expect(spies.errorOutput()).toContain("`my-app --help`");
  });

  test("注入 description 后 help 标题包含该描述", async () => {
    await runCli({
      argv: ["--help"],
      name: "my-app",
      version: "1.2.3",
      description: "面向开发者的小工具",
    });

    expect(spies.output()).toContain("my-app v1.2.3 - 面向开发者的小工具");
  });
});

describe("runCli - 自定义 commands", () => {
  test("注入空命令集时 help 显示「命令集为空」", async () => {
    const exitCode = await runCli({ argv: [], commands: [] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toContain("命令集为空");
    // 不应再列出内置 hello/echo/ask
    expect(spies.output()).not.toContain("hello");
    expect(spies.output()).not.toContain("echo");
  });

  test("注入自定义命令集时只能调度自定义命令", async () => {
    const customCommand = {
      name: "ping",
      description: "回复 pong",
      usage: "my-app ping",
      run: () => {
        console.log("pong");
        return 0;
      },
    };

    const exitCode = await runCli({
      argv: ["ping"],
      commands: [customCommand],
    });

    expect(exitCode).toBe(0);
    expect(spies.output()).toBe("pong");
  });

  test("注入自定义命令集时内置命令变得不可用", async () => {
    const customCommand = {
      name: "ping",
      description: "回复 pong",
      usage: "my-app ping",
      run: () => 0,
    };

    // 内置的 hello 没在注入命令集里，应该被认为是未知命令
    const exitCode = await runCli({
      argv: ["hello"],
      commands: [customCommand],
    });

    expect(exitCode).toBe(1);
    expect(spies.errorOutput()).toContain("未知命令: hello");
  });

  test("--help 只列出注入的命令集", async () => {
    const customCommands = [
      {
        name: "ping",
        description: "回复 pong",
        usage: "my-app ping",
        run: () => 0,
      },
      {
        name: "version-info",
        description: "打印环境信息",
        usage: "my-app version-info",
        run: () => 0,
      },
    ];

    await runCli({ argv: ["--help"], commands: customCommands });

    const output = spies.output();
    expect(output).toContain("ping");
    expect(output).toContain("version-info");
    expect(output).not.toContain("hello");
    expect(output).not.toContain("echo");
  });
});

describe("runCli - 未知命令", () => {
  test("未知命令时返回 1 并打印错误", async () => {
    const exitCode = await runCli({ argv: ["nope"] });

    expect(exitCode).toBe(1);
    expect(spies.errorOutput()).toContain("未知命令: nope");
    expect(spies.errorOutput()).toContain("--help");
  });

  test("未知命令不会触发 console.log（不会输出 help）", async () => {
    await runCli({ argv: ["nope"] });

    expect(spies.log).not.toHaveBeenCalled();
  });
});

describe("runCli - hello 命令", () => {
  test("hello 不带参数时对 world 打招呼", async () => {
    const exitCode = await runCli({ argv: ["hello"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toBe("Hello, world!");
  });

  test("hello 带参数时对参数打招呼", async () => {
    const exitCode = await runCli({ argv: ["hello", "alice"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toBe("Hello, alice!");
  });

  test("hello 多余参数被忽略，仅取第一个", async () => {
    const exitCode = await runCli({ argv: ["hello", "alice", "bob"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toBe("Hello, alice!");
  });

  test("hello 支持中文姓名", async () => {
    const exitCode = await runCli({ argv: ["hello", "寒朔"] });

    expect(exitCode).toBe(0);
    expect(spies.output()).toBe("Hello, 寒朔!");
  });
});

describe("runCli - 命令异常兜底", () => {
  test("命令 run 抛出 Error 时返回 1 并打印错误信息", async () => {
    // 不通过模块 mock 重写 commands.ts（那种做法依赖 Bun 模块缓存的隐式行为，不可靠）。
    // 改为在内置命令上注入一个临时会抛错的 run，测完恢复。
    // builtinCommands 是 readonly 引用，但其元素 run 是可写函数引用——这里替换 hello 的 run，
    // 让它在收到特定哨兵参数时抛错，验证 cli.ts 的 try/catch 兜底。
    const hello = findCommand("hello");
    expect(hello).toBeDefined();
    if (!hello) return;

    const originalRun = hello.run;
    const sentinelError = new Error("故意炸：单元测试触发");

    // 类型上 run 是 readonly，这里通过类型断言绕开仅为测试用途。
    (hello as { run: typeof hello.run }).run = () => {
      throw sentinelError;
    };

    try {
      const exitCode = await runCli({ argv: ["hello", "trigger"] });
      expect(exitCode).toBe(1);
      expect(spies.errorOutput()).toContain("故意炸：单元测试触发");
      expect(spies.errorOutput()).toContain("hello");
    } finally {
      (hello as { run: typeof hello.run }).run = originalRun;
    }
  });

  test("命令 run 抛出非 Error 值时也能转成字符串并返回 1", async () => {
    const hello = findCommand("hello");
    expect(hello).toBeDefined();
    if (!hello) return;

    const originalRun = hello.run;
    // 抛一个普通对象（非 Error 实例），覆盖 cli.ts 中 String(error) 的兜底分支。
    // 该对象自带 toString 让结果可读，避免出现 "[object Object]" 之类无意义的输出。
    const nonErrorThrowable = {
      toString: () => "非Error错误对象",
    };
    (hello as { run: typeof hello.run }).run = () => {
      throw nonErrorThrowable;
    };

    try {
      const exitCode = await runCli({ argv: ["hello", "trigger"] });
      expect(exitCode).toBe(1);
      expect(spies.errorOutput()).toContain("非Error错误对象");
    } finally {
      (hello as { run: typeof hello.run }).run = originalRun;
    }
  });
});
