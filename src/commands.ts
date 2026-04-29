/**
 * 内置示例子命令的实现集合。
 *
 * 每个命令都是一个纯函数，接收已经被 CLI 主流程剥离掉命令名后的参数数组，
 * 返回一个进程退出码（0 表示成功）。这样设计是为了：
 * 1. 命令逻辑与参数解析解耦，方便后续替换成更完整的解析器；
 * 2. 命令本身可单测——直接调用函数即可，无需 spawn 子进程。
 */

export type CommandHandler = (args: readonly string[]) => Promise<number> | number;

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly run: CommandHandler;
}

const helloCommand: CommandDefinition = {
  name: "hello",
  description: "向指定的人打招呼，默认对象是 world",
  usage: "nova-code hello [name]",
  run: (args) => {
    const target = args[0] ?? "world";
    console.log(`Hello, ${target}!`);
    return 0;
  },
};

const echoCommand: CommandDefinition = {
  name: "echo",
  description: "原样回显传入的参数",
  usage: "nova-code echo <text...>",
  run: (args) => {
    if (args.length === 0) {
      console.error("echo: 至少需要一个参数");
      return 1;
    }
    console.log(args.join(" "));
    return 0;
  },
};

const askCommand: CommandDefinition = {
  name: "ask",
  description: "通过标准输入读取一行问题并原样回显",
  usage: "nova-code ask",
  run: async () => {
    process.stdout.write("Your question: ");
    const question = await readLineFromStdin();
    if (question === null) {
      console.error("\nask: 未读取到输入");
      return 1;
    }
    console.log(`收到问题：${question}`);
    return 0;
  },
};

export const builtinCommands: readonly CommandDefinition[] = [
  helloCommand,
  echoCommand,
  askCommand,
];

/**
 * 在指定命令集中按名查找命令。命令集省略时落到内置命令集 `builtinCommands`。
 */
export function findCommand(
  name: string,
  commands: readonly CommandDefinition[] = builtinCommands,
): CommandDefinition | undefined {
  return commands.find((command) => command.name === name);
}

/**
 * 从 stdin 读取一行（不含换行符）。读到 EOF 且无内容时返回 null。
 *
 * 这里通过 ReadableStream.getReader() 显式驱动读取，原因：
 * Bun 当前版本的 stdin stream 类型未声明 [Symbol.asyncIterator]，
 * 直接 `for await` 会触发 TS2504。手动 reader 既类型安全，又行为明确。
 */
async function readLineFromStdin(): Promise<string | null> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        return buffer.slice(0, newlineIndex).replace(/\r$/, "");
      }
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  return buffer.length > 0 ? buffer.replace(/\r$/, "") : null;
}
