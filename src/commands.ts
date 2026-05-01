/**
 * 内置示例子命令的实现集合。
 *
 * 每个命令都是一个纯函数，接收已经被 CLI 主流程剥离掉命令名后的参数数组，
 * 返回一个进程退出码（0 表示成功）。这样设计是为了：
 * 1. 命令逻辑与参数解析解耦，方便后续替换成更完整的解析器；
 * 2. 命令本身可单测——直接调用函数即可，无需 spawn 子进程。
 */

import { loadConfig } from "./config/config.ts";
import { AbortError, ConfigError, LLMApiError, MaxTurnsExceededError } from "./llm/errors.ts";
import { runAgentLoop } from "./llm/query.ts";
import { builtinTools } from "./llm/tools.ts";

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
  description: "向 LLM 提问，模型可调用本地工具检索代码后给出回答",
  usage: 'nova-code ask [question]\n  或：echo "问题" | nova-code ask',
  run: async (args) => {
    // 优先使用命令行参数；没有则从 stdin 读一行（支持管道输入）
    const inlineQuestion = args.join(" ").trim();
    let question: string;
    if (inlineQuestion !== "") {
      question = inlineQuestion;
    } else {
      const isInteractive = process.stdin.isTTY === true;
      if (isInteractive) {
        process.stdout.write("Your question: ");
      }
      const fromStdin = await readLineFromStdin();
      if (fromStdin === null || fromStdin.trim() === "") {
        console.error("ask: 未提供问题。用法见 `nova-code --help`。");
        return 1;
      }
      question = fromStdin.trim();
    }

    return await runAskWithLLM(question);
  },
};

/**
 * ask 命令的 LLM 部分：
 * 1. 加载配置（缺 API key 时友好报错并提示如何配置）
 * 2. 跑 agent loop，把流式文本增量直接写到 stdout
 * 3. 工具调用以单行提示形式输出到 stderr，避免污染答案本身
 *
 * 退出码：0 = 正常结束；1 = 配置错误；2 = LLM/工具失败；130 = 用户中断
 */
async function runAskWithLLM(question: string): Promise<number> {
  // Ctrl+C：转成 abort signal 让 agent loop 优雅退出
  const abortController = new AbortController();
  const onSigint = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const config = await loadConfig();
    let inAssistantText = false;

    const generator = runAgentLoop({
      config,
      userPrompt: question,
      tools: builtinTools,
      signal: abortController.signal,
    });

    for await (const event of generator) {
      switch (event.type) {
        case "turn_start":
          // 第二轮起在工具调用之后，加一个空行让回答与工具输出分隔开
          if (event.turn > 1) {
            process.stderr.write("\n");
          }
          break;
        case "text_delta":
          process.stdout.write(event.delta);
          inAssistantText = true;
          break;
        case "tool_call":
          if (inAssistantText) {
            process.stdout.write("\n");
            inAssistantText = false;
          }
          process.stderr.write(`\n[tool] ${event.toolName} ${JSON.stringify(event.input)}\n`);
          break;
        case "tool_result":
          if (event.isError) {
            process.stderr.write(`[tool] ${event.toolName} failed: ${event.content}\n`);
          }
          break;
        case "done":
          // 末尾补一个换行，避免 shell 提示符紧贴输出
          process.stdout.write("\n");
          break;
        // turn_end 当前不需要展示给用户
        case "turn_end":
          break;
      }
    }
    return 0;
  } catch (error) {
    return handleAskError(error);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/** 把不同错误映射到合适的退出码 + 用户友好的提示。 */
function handleAskError(error: unknown): number {
  if (error instanceof ConfigError) {
    console.error(`\nask: ${error.message}`);
    return 1;
  }
  if (error instanceof AbortError) {
    console.error("\nask: 已中断。");
    return 130;
  }
  if (error instanceof MaxTurnsExceededError) {
    console.error(`\nask: ${error.message}`);
    return 2;
  }
  if (error instanceof LLMApiError) {
    const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
    console.error(`\nask: LLM 请求失败${status}：${error.message}`);
    return 2;
  }
  if (error instanceof Error) {
    console.error(`\nask: ${error.message}`);
    return 2;
  }
  console.error(`\nask: ${String(error)}`);
  return 2;
}

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
