/**
 * Memory extractor —— 端 turn 后台兜底提取。
 *
 * 对齐 claude-code/src/services/extractMemories/extractMemories.ts，但简化：
 *   - claude-code 用 runForkedAgent + cacheSafeParams 完美 fork（共享 prompt cache）
 *   - nova-code 复用 M11 sub-agent 模式（依赖注入 runAgentLoopFn），父消息文本化
 *     注入，cache prefix 不共享。代价：每次 extractor 走完整 prompt cache miss；
 *     收益：不引入新的 forkedAgent 基础设施，与 nova-code 现有 Agent tool 一致。
 *
 * 依赖注入 runAgentLoop 避免与 QueryEngine 形成循环：
 *   QueryEngine.ts → MemoryRuntime type → memoryRuntime.ts
 *   extractor.ts → 注入的 runAgentLoop（不直接 import QueryEngine）
 *
 * 调用流程：
 *   1. ChatSession / AskCommand 在 createMemoryRuntime 时构造 extractor 闭包
 *   2. 主 loop 结束 → memoryRuntime.runExtractorIfNeeded(messages) → 闭包被调
 *   3. 闭包：hasMemoryWritesSince 互斥 → 跳过 / 构 prompt → spawn subagent →
 *      drain events
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ResolvedConfig } from "../../config/config.ts";
import type { Tool } from "../../Tool.ts";
import type { AgentEvent, NovaContentBlock, NovaMessage } from "../../types/message.ts";
import { isAutoMemPath } from "./paths.ts";
import { formatMemoryManifest, scanMemoryFiles } from "./scan.ts";

/** 受信任白名单：extractor 子 agent 可调用的工具名。 */
export const EXTRACTOR_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  "FileRead",
  "Grep",
  "Glob",
  "LS",
  "FileEdit",
  "FileWrite",
]);

/** extractor 子 agent 最大轮次（read 一轮 + write 一轮 + 兜底）。 */
const EXTRACTOR_MAX_TURNS = 5;

/**
 * 触发 extractor 所需的最少新消息数（model-visible）。
 *
 * 单轮简短对话（user + assistant text）通常 = 2 条，没什么值得提取的；门控
 * 在这里能省掉绝大多数"打招呼 / 简单提问 / 一行 Q&A"场景的额外 LLM 调用。
 * 一旦出现 tool_use → tool_result 模式（≥ 4 条），就算 substantive，extractor 才介入。
 */
const EXTRACTOR_MIN_NEW_MESSAGES = 4;

/**
 * runAgentLoop 的最小同形签名 —— 用于依赖注入，避免循环依赖。
 * 字段命名与 AgentLoopParams 一致；extractor 只用其中几个字段。
 */
export type RunAgentLoopFn = (params: {
  readonly config: ResolvedConfig;
  readonly userPrompt: string;
  readonly systemPrompt?: string;
  readonly tools: readonly Tool[];
  readonly signal?: AbortSignal;
  readonly client?: Anthropic;
  readonly permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
}) => AsyncGenerator<AgentEvent, NovaMessage, void>;

export interface CreateMemoryExtractorFactoryParams {
  readonly runAgentLoop: RunAgentLoopFn;
  readonly client: Anthropic;
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  readonly memoryDir: string;
  readonly signal: AbortSignal;
}

/**
 * 创建一个端 turn 调用的 extractor 闭包。
 *
 * 闭包内部维护 `lastProcessedIndex` 游标，每次只处理新增 messages。主对话本轮
 * 已写过 memory（hasMemoryWritesSince 命中）则跳过本次，但仍推进 cursor。
 */
export function createMemoryExtractorFactory(
  params: CreateMemoryExtractorFactoryParams,
): (messages: ReadonlyArray<NovaMessage>) => Promise<void> {
  let lastProcessedIndex = 0;
  return async (messages) => {
    if (messages.length === 0 || messages.length <= lastProcessedIndex) {
      return;
    }
    const newMessages = messages.slice(lastProcessedIndex);

    // 短交互节流：单轮简短对话省一次 LLM 调用。**故意不推进 cursor**：
    // 多个短轮累计起来达到 EXTRACTOR_MIN_NEW_MESSAGES 时，下一轮 extractor 会一并处理
    // 之前所有"被攒着"的消息，避免"100 个短问题永远不触发提取"的退化场景。
    if (newMessages.length < EXTRACTOR_MIN_NEW_MESSAGES) {
      return;
    }
    lastProcessedIndex = messages.length;

    // 互斥：主对话本轮已经写了 memory，不必再 extractor
    if (hasMemoryWritesSince(newMessages, params.memoryDir)) {
      return;
    }

    const filteredTools = params.tools.filter((t) => EXTRACTOR_TOOL_WHITELIST.has(t.name));
    if (filteredTools.length === 0) {
      // 无可用工具：模型即使被 prompt 教唆也写不了 memory；省一次 LLM 调用
      return;
    }

    const existingMemoriesText = formatMemoryManifest(
      await scanMemoryFiles(params.memoryDir, params.signal),
    );
    const userPrompt = buildExtractorUserPrompt({
      newMessageCount: newMessages.length,
      existingMemories: existingMemoriesText,
      parentContext: serializeParentContext(newMessages),
    });

    const generator = params.runAgentLoop({
      config: { ...params.config, maxTurns: EXTRACTOR_MAX_TURNS },
      userPrompt,
      systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
      tools: filteredTools,
      signal: params.signal,
      client: params.client,
      // 不传 permissionMode / store / provider：让子 loop 走"无权限注入"分支，
      // 所有 tool_use 直接执行；安全靠 filteredTools 白名单 + 工具本身的 file_path
      // 校验（FileWrite/FileEdit 会被 isAutoMemPath 守住），不需要权限层兜底。
    });

    try {
      for await (const _event of generator) {
        // drain events — extractor 不渲染到主转录
      }
    } catch {
      // extractor 失败不阻塞主流程；具体错误在 runtime.runExtractorIfNeeded 的
      // try/catch 里已被吞，这里再加一层防御
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// hasMemoryWritesSince：检测主对话是否已经把 memory 写过
// ────────────────────────────────────────────────────────────────────────────

/**
 * 扫描一段消息切片，判断是否含写 memory 的 tool_use 块。
 *
 * 命中规则：assistant 消息 → tool_use 块 → name ∈ {FileWrite, FileEdit} →
 * input.path 经 resolve 后命中 isAutoMemPath。
 *
 * 用于：主对话本轮已自主写过 memory → extractor 跳过避免重复。
 */
export function hasMemoryWritesSince(
  messages: ReadonlyArray<NovaMessage>,
  memoryDir: string,
): boolean {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_use") continue;
      if (block.name !== "FileWrite" && block.name !== "FileEdit") continue;
      const filePath = extractFilePathFromInput(block.input);
      if (filePath === undefined) continue;
      if (isAutoMemPath(filePath, memoryDir)) return true;
    }
  }
  return false;
}

function extractFilePathFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)["path"];
  return typeof value === "string" ? value : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt：移植自 claude-code/src/services/extractMemories/prompts.ts
// ────────────────────────────────────────────────────────────────────────────

const EXTRACTOR_SYSTEM_PROMPT = `You are a nova-code memory extraction subagent. Your sole job is to extract durable memories from a recent slice of a parent conversation and write them to the persistent memory directory.

Stay strictly in scope:
- Only use content from the messages shown in <recent_messages>.
- Do NOT investigate the codebase further (no grep / git / read random files just to verify a claim).
- Do NOT respond conversationally; your job is to write files.

You have a limited turn budget. The efficient pattern:
- Turn 1: in PARALLEL, FileRead every existing memory file you might want to update (no other tool calls this turn).
- Turn 2: in PARALLEL, FileWrite new memory files / FileEdit existing ones and update MEMORY.md.
- Then stop (return without further tool calls).

If there is nothing worth saving in the slice, simply respond with "no memories to extract this round" and stop.`;

interface BuildExtractorUserPromptParams {
  readonly newMessageCount: number;
  readonly existingMemories: string;
  readonly parentContext: string;
}

function buildExtractorUserPrompt(params: BuildExtractorUserPromptParams): string {
  const manifestSection =
    params.existingMemories.length > 0
      ? `\n\n## Existing memory files\n\n${params.existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : "\n\n## Existing memory files\n\n(none yet — first time writing memories for this project)";

  return [
    `Analyze the most recent ${params.newMessageCount} messages from the parent conversation (shown below) and extract durable memories.`,
    "",
    "Save only:",
    "- **user**: persistent facts about the user (role / goals / knowledge background).",
    "- **feedback**: corrections or validated approaches the user gave you, with **Why:** + **How to apply:** lines.",
    '- **project**: ongoing work / decisions / deadlines that are NOT derivable from code or git history; convert relative dates to absolute (e.g. "Thursday" → "2026-05-29").',
    "- **reference**: pointers to external systems (Linear projects, Slack channels, Grafana boards, etc).",
    "",
    "Do NOT save:",
    "- Code patterns, architecture, file paths, project structure (derivable from current code).",
    "- Git history / who-changed-what (use git log).",
    "- Debugging fix recipes (the fix is in the code; commit message has context).",
    "- Ephemeral task details / in-progress state.",
    manifestSection,
    "",
    "<recent_messages>",
    params.parentContext,
    "</recent_messages>",
    "",
    "Now write the memories (Turn 1: parallel reads; Turn 2: parallel writes; Stop).",
  ].join("\n");
}

const MAX_PARENT_CONTEXT_CHARS = 24_000;
const MAX_PARENT_BLOCK_CHARS = 4_000;

function serializeParentContext(messages: ReadonlyArray<NovaMessage>): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${truncate(m.content, MAX_PARENT_BLOCK_CHARS)}`);
      continue;
    }
    const blockTexts: string[] = [];
    for (const block of m.content) {
      blockTexts.push(formatBlockForContext(block));
    }
    lines.push(`${m.role}:\n${truncate(blockTexts.join("\n"), MAX_PARENT_BLOCK_CHARS)}`);
  }
  return truncate(lines.join("\n\n"), MAX_PARENT_CONTEXT_CHARS);
}

function formatBlockForContext(block: NovaContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.source.media_type}]`;
    case "tool_use":
      return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
    case "tool_result":
      return `[tool_result] ${typeof block.content === "string" ? block.content : "(non-text)"}`;
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;
}
