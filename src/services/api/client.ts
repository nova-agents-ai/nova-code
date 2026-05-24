/**
 * Anthropic SDK 实例的薄封装。
 *
 * M1.5 起从 src/llm/client.ts 搬到 src/services/api/client.ts，结构对齐
 * claude-code/src/services/api/client.ts；与之相比这里只保留最本质的部分：
 * - 仅支持 Anthropic 官方 API（不支持 Bedrock / Vertex / Foundry）
 * - 不做 OAuth 自动刷新（用户自己管理 API key）
 * - 不注入 session id / x-app / 自定义 headers（避免泄漏标识符给上游）
 *
 * 为什么要单独抽这个文件？
 * - 集中管理 SDK 构造逻辑，方便后续加 timeout / proxy / 自定义 fetch
 * - QueryEngine 测试时通过依赖注入替换 client（见 runAgentLoop 的 client 参数）
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedConfig } from "../../config/config.ts";
import { createMockAnthropicClient, type MockScenario } from "./mockClient.ts";

/**
 * 默认 SDK 内部重试次数。Anthropic SDK 自带指数退避，2 次重试足以覆盖
 * 瞬时网络抖动；过多重试会拖长用户感知的失败时间。
 */
const DEFAULT_MAX_RETRIES = 2;

/** 默认请求超时（毫秒）。流式请求 10 分钟够用。 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * 根据配置创建 Anthropic SDK 客户端。
 *
 * 同步函数：构造 SDK 不发起网络请求，所以无需 await。
 */
export function createAnthropicClient(config: ResolvedConfig): Anthropic {
  if (process.env["NOVA_TRANSPORT"] === "mock") {
    const scenario = parseMockScenario(process.env["NOVA_MOCK_SCENARIO"]);
    return createMockAnthropicClient({
      scenario,
      logFile: process.env["NOVA_MOCK_LOG_FILE"],
    });
  }

  const options: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: config.apiKey,
    maxRetries: DEFAULT_MAX_RETRIES,
    timeout: DEFAULT_TIMEOUT_MS,
  };
  if (config.baseURL !== undefined) {
    options.baseURL = config.baseURL;
  }
  return new Anthropic(options);
}

function parseMockScenario(value: string | undefined): MockScenario {
  if (
    value === "edit-loop" ||
    value === "todo-loop" ||
    value === "web-loop" ||
    value === "mcp-loop" ||
    value === "skill-loop" ||
    value === "agent-loop" ||
    value === "rules-loop" ||
    value === "plan-loop"
  ) {
    return value;
  }
  return "chat";
}
