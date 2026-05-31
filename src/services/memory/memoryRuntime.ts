/**
 * MemoryRuntime —— 把 paths / prompt / relevance / extractor 聚合成一个会话级
 * 运行时句柄，QueryEngine 与命令入口（AskCommand / ChatCommand）都引用同一份。
 *
 * 接口形状参考 services/projectInstructions ProjectInstructionsRuntime：
 *   - getInstructions(): 同步返回 system prompt 段（缓存），QueryEngine 每轮调
 *   - refreshInstructions(): 异步重读 MEMORY.md（模型可能在上一轮写过）
 *   - resolveRelevantMemories(query, signal): per-turn LLM 相关性召回
 *   - markSurfaced(memories): 记录已注入的文件，避免下一轮重复
 *   - runExtractorIfNeeded(messages): 端 turn 后台 extractor（M16 实施中由
 *     createMemoryRuntime 的 extractorFactory 注入，runtime 自身不依赖 QueryEngine）
 *
 * 设计要点：
 *   1. getInstructions() 同步 + 缓存：QueryEngine 每轮重建 system prompt 时无 IO 开销；
 *      模型写 memory 后，runAgentLoop 在下一轮顶端 await refreshInstructions() 即可
 *      看到最新 MEMORY.md。
 *   2. extractorFactory 闭包注入：runtime 不直接 import QueryEngine（避免循环依赖）；
 *      AskCommand / ChatCommand 在创建 runtime 时把"派生受限子 agent"的 factory 传入。
 *   3. surfacedPaths 在 runtime 实例内累积；compact / clear 重置由调用方负责（M16
 *      不与 compact 集成，留作后续）。
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { NovaMessage } from "../../types/message.ts";
import { memoryAge, memoryFreshnessText } from "./age.ts";
import {
  ENTRYPOINT_NAME,
  ensureMemoryDirExists,
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from "./paths.ts";
import { loadMemoryPrompt } from "./prompt.ts";
import { findRelevantMemories } from "./relevance.ts";
import type { RelevantMemory, SurfacedMemory } from "./types.ts";

/** 单条 memory 文件注入时的最大字节数（防止超长文件爆 user content）。 */
const MAX_MEMORY_SURFACE_BYTES = 32 * 1024;

export interface MemoryRuntime {
  /** memory 目录绝对路径（带尾部 sep）。权限 carve-out 用。 */
  readonly memoryDir: string;
  /** MEMORY.md 索引文件绝对路径。 */
  readonly entrypointPath: string;
  /** 同步返回 system prompt 段；runtime 未启用 / 缓存未就绪时 undefined。 */
  getInstructions(): string | undefined;
  /** 异步重读 MEMORY.md 并刷新缓存。runAgentLoop 在每轮顶端调一次。 */
  refreshInstructions(): Promise<void>;
  /** per-turn LLM 相关性召回；不启用 / 失败时返回空数组。 */
  resolveRelevantMemories(query: string, signal: AbortSignal): Promise<readonly SurfacedMemory[]>;
  /** 标记已注入；下一次 resolve 时这些路径在 manifest 前就被过滤。 */
  markSurfaced(memories: readonly SurfacedMemory[]): void;
  /** 端 turn 异步触发 extractor；factory 由命令入口注入。fire-and-forget。 */
  runExtractorIfNeeded(messages: ReadonlyArray<NovaMessage>): Promise<void>;
}

export interface CreateMemoryRuntimeParams {
  readonly client: Anthropic;
  readonly model: string;
  /** ResolvedConfig.autoMemoryEnabled；undefined / true → 默认开。 */
  readonly autoMemoryEnabled?: boolean;
  /** 通常 process.cwd()。 */
  readonly cwd: string;
  /** 通常 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * 端 turn 触发的 extractor factory builder。
   *
   * 设计动机：extractor 需要 memoryDir（已解析的绝对路径），但 memoryDir 由
   * createMemoryRuntime 内部从 cwd + env 推断。让上层"先建 factory 再传"会
   * 引入鸡蛋问题（factory 闭包必须已知 memoryDir）。改成 builder 模式：上层
   * 提供 `(memoryDir) => extractorFn` 工厂的工厂；runtime 解析完 memoryDir
   * 后再调一次 builder 拿到真正的 extractor 闭包。
   *
   * 不传时 runExtractorIfNeeded 是 no-op（适合不需要兜底提取的场景）。
   */
  readonly extractorFactoryBuilder?: (
    memoryDir: string,
  ) => (messages: ReadonlyArray<NovaMessage>) => Promise<void>;
}

/**
 * 创建 MemoryRuntime。流程：
 *   1. 检查 isAutoMemoryEnabled → 关 → 返回 disabled runtime（所有方法 no-op）
 *   2. 解析 memoryDir / entrypointPath
 *   3. ensureMemoryDirExists
 *   4. 初次 refreshInstructions
 *
 * 返回的 runtime 立即可用：getInstructions() 已返回拼好的 system prompt 段。
 */
export async function createMemoryRuntime(
  params: CreateMemoryRuntimeParams,
): Promise<MemoryRuntime> {
  const env = params.env ?? process.env;
  const enabled = isAutoMemoryEnabled({
    env,
    ...(params.autoMemoryEnabled !== undefined
      ? { configAutoMemoryEnabled: params.autoMemoryEnabled }
      : {}),
  });
  if (!enabled) {
    return createDisabledRuntime();
  }

  const memoryDir = await getAutoMemPath({ cwd: params.cwd, env });
  const entrypointPath = await getAutoMemEntrypoint({ cwd: params.cwd, env });
  await ensureMemoryDirExists(memoryDir);

  const state: MutableState = {
    instructions: undefined,
    surfacedPaths: new Set(),
  };

  await refreshInstructionsInto(state, memoryDir, entrypointPath);

  const extractor = params.extractorFactoryBuilder?.(memoryDir);

  return {
    memoryDir,
    entrypointPath,
    getInstructions: () => state.instructions,
    refreshInstructions: () => refreshInstructionsInto(state, memoryDir, entrypointPath),
    resolveRelevantMemories: async (query, signal) => {
      const relevant = await findRelevantMemories({
        query,
        memoryDir,
        client: params.client,
        model: params.model,
        signal,
        alreadySurfaced: state.surfacedPaths,
      });
      return await readSurfacedMemories(relevant);
    },
    markSurfaced: (memories) => {
      for (const m of memories) {
        state.surfacedPaths.add(m.path);
      }
    },
    runExtractorIfNeeded: async (messages) => {
      if (extractor === undefined) return;
      try {
        await extractor(messages);
      } catch {
        // extractor 失败不能影响主流程；具体错误由 factory 内部 log
      }
    },
  };
}

/** memory 关闭时使用的 no-op runtime，让上层不必到处判空。 */
function createDisabledRuntime(): MemoryRuntime {
  return {
    memoryDir: "",
    entrypointPath: "",
    getInstructions: () => undefined,
    refreshInstructions: async () => {},
    resolveRelevantMemories: async () => [],
    markSurfaced: () => {},
    runExtractorIfNeeded: async () => {},
  };
}

interface MutableState {
  instructions: string | undefined;
  readonly surfacedPaths: Set<string>;
}

async function refreshInstructionsInto(
  state: MutableState,
  memoryDir: string,
  entrypointPath: string,
): Promise<void> {
  try {
    state.instructions = await loadMemoryPrompt({ memoryDir, entrypointPath });
  } catch {
    state.instructions = undefined;
  }
}

/**
 * 把 RelevantMemory[] 真读出来并装成 SurfacedMemory[]：header 是注入时的人类
 * 可读标签（含新鲜度），content 是文件正文（超过 MAX_MEMORY_SURFACE_BYTES 截断）。
 *
 * 单文件读失败：静默跳过（不影响其它）。
 */
async function readSurfacedMemories(
  relevant: ReadonlyArray<RelevantMemory>,
): Promise<readonly SurfacedMemory[]> {
  const out: SurfacedMemory[] = [];
  for (const r of relevant) {
    try {
      const file = Bun.file(r.path);
      if (!(await file.exists())) continue;
      const text = await readWithLimit(file, MAX_MEMORY_SURFACE_BYTES);
      out.push({
        path: r.path,
        mtimeMs: r.mtimeMs,
        content: text,
        header: buildSurfaceHeader(r.path, r.mtimeMs),
      });
    } catch {
      // 单文件读失败不影响其它
    }
  }
  return out;
}

async function readWithLimit(file: ReturnType<typeof Bun.file>, maxBytes: number): Promise<string> {
  if (file.size <= maxBytes) {
    return await file.text();
  }
  const slice = file.slice(0, maxBytes);
  const truncatedText = await slice.text();
  return `${truncatedText}\n\n[truncated at ${maxBytes} bytes]`;
}

function buildSurfaceHeader(path: string, mtimeMs: number): string {
  const stale = memoryFreshnessText(mtimeMs);
  return stale !== ""
    ? `${stale}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`;
}

/**
 * 把一组 SurfacedMemory 渲染成单段 user-context 文本（含 `<system-reminder>` 包装）。
 *
 * 由命令入口（AskCommand / ChatCommand）在拼 userMessageContent 时调；空数组返回 ""，
 * 调用方可据此决定是否要在 user message 前 prepend 这段文本。
 *
 * 设计：所有 memory 共享一段 <system-reminder>（而不是每条独立包装），是因为
 * nova-code user content 是单一 text block 列表；少包装层让模型注意力聚焦在
 * memory 本体上，而不是连续的 `<system-reminder>` 标签噪声。
 */
export function renderRelevantMemoriesAsSystemReminder(
  memories: readonly SurfacedMemory[],
): string {
  if (memories.length === 0) return "";
  const blocks = memories.map((m) => `${m.header}\n\n${m.content}`).join("\n\n---\n\n");
  return `<system-reminder>\n${blocks}\n</system-reminder>`;
}

/** 仅供单测：识别 disabled runtime 是否真的什么都没做（memoryDir 为空串）。 */
export function isDisabledRuntime(runtime: MemoryRuntime): boolean {
  return runtime.memoryDir === "";
}

/** Re-export 一些常量，避免上层把 paths.ts / promptText.ts 内部细节都摊出来。 */
export { ENTRYPOINT_NAME };
