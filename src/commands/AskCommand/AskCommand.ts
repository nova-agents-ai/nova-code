/**
 * ask 命令定义：向 LLM 提问，允许模型调用本地工具后给出回答。
 *
 * 只负责"收集 question + flag"的 I/O 胶水，实际 LLM 调用委托给 runAskWithLLM。
 */

import type { CommandDefinition } from "../types.ts";
import { parseAskFlags } from "./parseAskFlags.ts";
import { runAskWithLLM } from "./runAskWithLLM.ts";

export const askCommand: CommandDefinition = {
  name: "ask",
  description: "向 LLM 提问，模型可调用本地工具检索代码后给出回答",
  usage:
    "nova-code ask [--debug] [--debug-pretty] [question]\n" +
    '  或：echo "问题" | nova-code ask\n' +
    "  --debug:        把完整 AgentEvent 流写入 ~/.nova-code/logs/ 下的会话日志文件（不污染 stderr）\n" +
    "  --debug-pretty: 隐含开启 --debug；日志文件改用多行缩进 JSON 并把字符串中的 \\n 解析成真换行，便于肉眼阅读",
  run: async (args) => {
    const { debug, pretty, dangerouslySkipPermissions, rest } = parseAskFlags(args);

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

    return await runAskWithLLM(question, { debug, pretty, dangerouslySkipPermissions });
  },
};

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
