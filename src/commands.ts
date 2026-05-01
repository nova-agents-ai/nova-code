/**
 * 内置示例子命令的实现集合。
 *
 * 每个命令都是一个纯函数，接收已经被 CLI 主流程剥离掉命令名后的参数数组，
 * 返回一个进程退出码（0 表示成功）。这样设计是为了：
 * 1. 命令逻辑与参数解析解耦，方便后续替换成更完整的解析器；
 * 2. 命令本身可单测——直接调用函数即可，无需 spawn 子进程。
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getLogsDirPath, loadConfig } from "./config/config.ts";
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
  usage:
    "nova-code ask [--debug] [--debug-pretty] [question]\n" +
    '  或：echo "问题" | nova-code ask\n' +
    "  --debug:        把完整 AgentEvent 流写入 ~/.nova-code/logs/ 下的会话日志文件（不污染 stderr）\n" +
    "  --debug-pretty: 隐含开启 --debug；日志文件改用多行缩进 JSON 并把字符串中的 \\n 解析成真换行，便于肉眼阅读",
  run: async (args) => {
    const { debug, pretty, rest } = parseAskFlags(args);

    // 优先使用命令行参数；没有则从 stdin 读一行（支持管道输入）
    const inlineQuestion = rest.join(" ").trim();
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

    return await runAskWithLLM(question, { debug, pretty });
  },
};

interface AskFlags {
  readonly debug: boolean;
  readonly pretty: boolean;
  readonly rest: readonly string[];
}

/**
 * 解析 ask 命令支持的 flag。当前支持 --debug、--debug-pretty，均可出现在任意位置。
 * --debug-pretty 隐含开启 --debug：用户只关心"格式化"时不必再写 --debug。
 *
 * 故意不引入第三方解析器：flag 集合极小，手工解析更直观且无依赖；
 * 后续若 flag 增多，可整体替换为 parseArgs（Node 内置）或 commander。
 */
export function parseAskFlags(args: readonly string[]): AskFlags {
  let debug = false;
  let pretty = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    if (arg === "--debug-pretty") {
      debug = true;
      pretty = true;
      continue;
    }
    rest.push(arg);
  }
  return { debug, pretty, rest };
}

interface RunAskOptions {
  readonly debug: boolean;
  readonly pretty: boolean;
}

/**
 * 一个 debug "汇"：负责把单条 payload 同时写到 stderr 与会话日志文件。
 * 文件句柄通过 close() 关闭；非 debug 模式下用 NULL_DEBUG_SINK 占位（全部 no-op）。
 */
interface DebugSink {
  readonly write: (payload: unknown) => void;
  readonly close: () => void;
  /** 日志文件路径；NULL sink 时为 null。仅供测试与提示用。 */
  readonly logFilePath: string | null;
}

const NULL_DEBUG_SINK: DebugSink = {
  write: () => undefined,
  close: () => undefined,
  logFilePath: null,
};

/**
 * ask 命令的 LLM 部分：
 * 1. 加载配置（缺 API key 时友好报错并提示如何配置）
 * 2. 跑 agent loop，把流式文本增量直接写到 stdout
 * 3. 工具调用以单行提示形式输出到 stderr，避免污染答案本身
 * 4. debug 模式下：整份 AgentEvent 流追加到 ~/.nova-code/logs/ask-<timestamp>-<pid>.log
 *    （**不写 stderr**，避免污染交互；用户只在 stderr 看到一行 "log file: ..." 提示）
 * 5. --debug-pretty 进一步把日志文件格式化：多行缩进 + 把字符串里的 \n 渲染成真换行
 *
 * 退出码：0 = 正常结束；1 = 配置错误；2 = LLM/工具失败；130 = 用户中断
 */
async function runAskWithLLM(question: string, options: RunAskOptions): Promise<number> {
  // Ctrl+C：转成 abort signal 让 agent loop 优雅退出
  const abortController = new AbortController();
  const onSigint = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", onSigint);

  // debug sink 在 try 之外创建，但 close 一定要在 finally 兜底
  const debugSink: DebugSink = options.debug
    ? createFileDebugSink({ pretty: options.pretty })
    : NULL_DEBUG_SINK;

  try {
    if (options.debug && debugSink.logFilePath !== null) {
      // 让用户知道完整日志去哪儿了；此条只走 stderr，不入日志文件（避免冗余）
      process.stderr.write(`[debug] log file: ${debugSink.logFilePath}\n`);
      if (options.pretty) {
        process.stderr.write("[debug] pretty mode: on\n");
      }
    }

    const config = await loadConfig();
    let inAssistantText = false;

    if (options.debug) {
      // 把生效配置脱敏后写入日志，便于排查"为什么连到了错误的 endpoint"
      debugSink.write({
        type: "config_loaded",
        model: config.model,
        baseURL: config.baseURL ?? null,
        apiKeyTail: config.apiKey.slice(-4),
      });
    }

    const generator = runAgentLoop({
      config,
      userPrompt: question,
      tools: builtinTools,
      signal: abortController.signal,
    });

    for await (const event of generator) {
      debugSink.write(event);

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
        // turn_end 当前不需要展示给用户（debug 模式已通过 debugSink 输出）
        case "turn_end":
          break;
      }
    }
    return 0;
  } catch (error) {
    return handleAskError(error);
  } finally {
    debugSink.close();
    process.removeListener("SIGINT", onSigint);
  }
}

interface CreateFileDebugSinkOptions {
  /** 是否使用多行缩进 + 字符串内换行渲染。 */
  readonly pretty: boolean;
}

/**
 * 创建一个 debug sink：把每条 payload 序列化后追加到日志文件。
 *
 * 设计取舍：
 * - **不写 stderr**：debug 输出只入文件，避免污染交互；用户在 stderr 仅能看到
 *   "log file: <path>" 一行提示，知道日志去哪了
 * - 同步 IO（openSync/writeSync）：debug 量极小（每事件几百字节～几 KB），同步写
 *   保证事件顺序严格 = 时序顺序，避免 async 队列重排造成日志错位
 * - 'a' 模式追加：即使重名（同秒同 pid 极端情况）也不会丢之前内容
 * - 文件名含 timestamp + pid：单进程一个文件、便于 ls -lt 看时序
 * - 创建失败 → 打印警告但**不阻断**主流程，降级为 NULL sink（debug 静默丢弃）
 */
function createFileDebugSink(options: CreateFileDebugSinkOptions): DebugSink {
  const logsDir = getLogsDirPath();
  const fileName = buildDebugLogFileName(new Date(), process.pid);
  const filePath = join(logsDir, fileName);

  let fd: number;
  try {
    mkdirSync(logsDir, { recursive: true });
    fd = openSync(filePath, "a");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[debug] failed to open log file ${filePath}: ${reason}\n`);
    process.stderr.write("[debug] debug output will be discarded.\n");
    return NULL_DEBUG_SINK;
  }

  return {
    write: (payload) => {
      const text = formatDebugPayload(payload, options.pretty);
      // 文件落盘失败不应中断主流程；最坏情况是日志缺一条
      try {
        writeSync(fd, text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[debug] failed to append to log file: ${reason}\n`);
      }
    },
    close: () => {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败无需暴露给用户：进程退出时 OS 也会回收
      }
    },
    logFilePath: filePath,
  };
}

/**
 * 把 debug payload 序列化为日志文件中的文本块。
 *
 * 紧凑模式（pretty=false）：单行 `[debug] {json}\n`，同 1.0 版本，便于 grep/jq 流式处理。
 *
 * 美化模式（pretty=true）：
 *   1. 多行缩进 JSON（2 空格）
 *   2. 字符串值里的 \n / \r / \t 渲染成真换行/制表（无需额外工具就能肉眼读多行文本）
 *   3. 事件之间加分隔线 `--- {type} ---`，便于扫读
 *
 * 美化模式下"渲染换行"的实现思路：
 *   JSON.stringify 会把真换行转义成 "\\n"；为了让最终文本里出现真换行，
 *   先在 replacer 里把字符串中的换行替换成一个稀有 sentinel（U+0001 U+0001，
 *   不会出现在正常文本里），stringify 后再把 sentinel 还原为真字节。
 *   这样既保留了 JSON 结构（引号、缩进、键名），又能看到多行原文。
 */
export function formatDebugPayload(payload: unknown, pretty: boolean): string {
  if (!pretty) {
    return `[debug] ${JSON.stringify(payload)}\n`;
  }

  const NEWLINE_SENTINEL = "\u0001\u0001NL\u0001\u0001";
  const TAB_SENTINEL = "\u0001\u0001TAB\u0001\u0001";
  const CR_SENTINEL = "\u0001\u0001CR\u0001\u0001";

  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value !== "string") return value;
    return value
      .replaceAll("\r\n", NEWLINE_SENTINEL)
      .replaceAll("\n", NEWLINE_SENTINEL)
      .replaceAll("\r", CR_SENTINEL)
      .replaceAll("\t", TAB_SENTINEL);
  };

  const json = JSON.stringify(payload, replacer, 2);
  const rendered = json
    .replaceAll(NEWLINE_SENTINEL, "\n")
    .replaceAll(CR_SENTINEL, "\r")
    .replaceAll(TAB_SENTINEL, "\t");

  const eventType =
    payload !== null && typeof payload === "object" && "type" in payload
      ? String((payload as { type: unknown }).type)
      : "event";

  return `--- ${eventType} ---\n${rendered}\n\n`;
}

/**
 * 构造日志文件名：ask-YYYY-MM-DDTHH-mm-ss-<pid>.log。
 * 形如 ask-2026-05-01T15-11-23-42649.log，按字典序就是时序，便于排序定位。
 *
 * 抽成纯函数是为了可单测——内部 new Date() 不便注入。
 */
export function buildDebugLogFileName(now: Date, pid: number): string {
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  const ts =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  return `ask-${ts}-${pid}.log`;
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
