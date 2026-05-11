/**
 * ask 命令的 LLM 调用主循环：负责串起配置加载、agent loop、debug sink、错误映射。
 *
 * 流程：
 * 1. 加载配置（缺 API key 时友好报错并提示如何配置）
 * 2. 跑 agent loop，把流式文本增量直接写到 stdout
 * 3. 工具调用以单行提示形式输出到 stderr，避免污染答案本身
 * 4. debug 模式下：整份 AgentEvent 流追加到 ~/.nova-code/logs/ask-<timestamp>-<pid>.log
 *    （**不写 stderr**，避免污染交互；用户只在 stderr 看到一行 "log file: ..." 提示）
 * 5. --debug-pretty 进一步把日志文件格式化：多行缩进 + 把字符串里的 \n 渲染成真换行
 *
 * 退出码：0 = 正常结束；1 = 配置错误；2 = LLM/工具失败；130 = 用户中断
 */

import { loadConfig } from "../../config/config.ts";
import { AbortError, ConfigError, MaxTurnsExceededError } from "../../errors/index.ts";
import { runAgentLoop } from "../../QueryEngine.ts";
import { LLMApiError } from "../../services/api/errors.ts";
import { builtinTools } from "../../tools.ts";
import { createFileDebugSink, type DebugSink, NULL_DEBUG_SINK } from "./debugSink.ts";

export interface RunAskOptions {
  readonly debug: boolean;
  readonly pretty: boolean;
}

export async function runAskWithLLM(question: string, options: RunAskOptions): Promise<number> {
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
  // LLM 原始请求/响应日志写入独立文件（ask-llm-*.log），与 AgentEvent 日志并列
  const llmLogSink: DebugSink = options.debug
    ? createFileDebugSink({ pretty: options.pretty, prefix: "ask-llm" })
    : NULL_DEBUG_SINK;

  try {
    if (options.debug && debugSink.logFilePath !== null) {
      // 让用户知道完整日志去哪儿了；此条只走 stderr，不入日志文件（避免冗余）
      process.stderr.write(`[debug] log file: ${debugSink.logFilePath}\n`);
      if (llmLogSink.logFilePath !== null) {
        process.stderr.write(`[debug] llm log file: ${llmLogSink.logFilePath}\n`);
      }
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
      llmLogSink: options.debug ? llmLogSink : undefined,
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
    llmLogSink.close();
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
