/**
 * Memory 相关性 selector：从全量 frontmatter manifest 中挑出最相关的 ≤5 条
 * topic 文件，作为 `<system-reminder>` 注入主对话 user content。
 *
 * 对齐 claude-code/src/memdir/findRelevantMemories.ts：
 *   - 用一次 LLM 调用挑选（不用 embedding / 向量库）
 *   - 单一系统提示 SELECT_MEMORIES_SYSTEM_PROMPT 教模型怎么选
 *   - 提供 recentTools 让 selector 跳过"正在被使用的工具的 reference 文档"
 *   - alreadySurfaced 在送入 selector 前过滤，节省 5 个 slot
 *
 * 实现差异（vs claude-code）：
 *   - claude-code 用 sideQuery + output_format json_schema（OpenAI 风格的结构化输出）
 *   - nova-code 用 Anthropic Messages API 文本返回 + JSON parse fallback；提示词
 *     里强制 "Return ONLY a JSON object..."，selector 模型 Sonnet/Haiku 都能稳定遵循
 *   - 用 `config.model` 作 selector model；M17 多 provider 时可分层换 Haiku
 */

import type Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "../analytics/index.ts";
import { formatMemoryManifest, scanMemoryFiles } from "./scan.ts";
import type { MemoryHeader, RelevantMemory } from "./types.ts";

/** 单次最多返回 5 条相关 memory。 */
const MAX_SELECTED = 5;

/** selector LLM 调用的 max_tokens；只用于返回 JSON 列表，不需要太多。 */
const SELECTOR_MAX_TOKENS = 256;

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to nova-code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to nova-code as it processes the user's query (up to ${MAX_SELECTED}). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (nova-code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.

Output format: Return ONLY a JSON object with a single key "selected_memories" containing an array of filenames. No prose, no markdown fences. Example:
{"selected_memories": ["user_role.md", "feedback_testing.md"]}`;

export interface FindRelevantMemoriesParams {
  readonly query: string;
  readonly memoryDir: string;
  readonly client: Anthropic;
  readonly model: string;
  readonly signal: AbortSignal;
  /** 最近成功调用过的工具名集合：让 selector 跳过这些工具的 reference 文档。 */
  readonly recentTools?: readonly string[];
  /** 已经在前几轮注入过的 memory 文件路径：在 manifest 阶段过滤掉。 */
  readonly alreadySurfaced?: ReadonlySet<string>;
}

/**
 * 主入口：扫描目录 → 调 LLM 选 → 返回 RelevantMemory[]。
 *
 * 失败兜底：扫描失败、LLM 调用失败、JSON parse 失败 → 一律返回空数组，不抛错。
 * 这是性能优化路径，不能因为它的失败阻塞主对话。
 */
export async function findRelevantMemories(
  params: FindRelevantMemoriesParams,
): Promise<readonly RelevantMemory[]> {
  const surfaced = params.alreadySurfaced ?? new Set<string>();
  const memories = (await scanMemoryFiles(params.memoryDir, params.signal)).filter(
    (m) => !surfaced.has(m.filePath),
  );

  if (memories.length === 0) {
    logEvent("tengu_memdir_relevance_skipped", { reason: "no_candidates" });
    return [];
  }

  const filenames = await selectRelevantFilenames({
    query: params.query,
    memories,
    client: params.client,
    model: params.model,
    signal: params.signal,
    recentTools: params.recentTools ?? [],
  });

  const byFilename = new Map(memories.map((m) => [m.filename, m]));
  const selected: RelevantMemory[] = [];
  for (const filename of filenames) {
    const header = byFilename.get(filename);
    if (header !== undefined) {
      selected.push({ path: header.filePath, mtimeMs: header.mtimeMs });
    }
  }
  logEvent("tengu_memdir_relevance_collected", {
    candidate_count: memories.length,
    selected_count: selected.length,
  });
  return selected.slice(0, MAX_SELECTED);
}

interface SelectFilenamesParams {
  readonly query: string;
  readonly memories: readonly MemoryHeader[];
  readonly client: Anthropic;
  readonly model: string;
  readonly signal: AbortSignal;
  readonly recentTools: readonly string[];
}

async function selectRelevantFilenames(params: SelectFilenamesParams): Promise<readonly string[]> {
  const validFilenames = new Set(params.memories.map((m) => m.filename));
  const manifest = formatMemoryManifest(params.memories);
  const toolsSection =
    params.recentTools.length > 0
      ? `\n\nRecently used tools: ${params.recentTools.join(", ")}`
      : "";

  try {
    const response = await params.client.messages.create(
      {
        model: params.model,
        max_tokens: SELECTOR_MAX_TOKENS,
        system: SELECT_MEMORIES_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Query: ${params.query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
          },
        ],
      },
      { signal: params.signal },
    );
    const textBlock = response.content.find((block) => block.type === "text");
    if (textBlock === undefined || textBlock.type !== "text") return [];
    return parseSelectedFilenames(textBlock.text, validFilenames);
  } catch (error) {
    if (params.signal.aborted) return [];
    logEvent("tengu_memdir_relevance_error", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

/**
 * 从模型文本输出里解析 `{"selected_memories": [...]}`。
 *
 * 容错：
 *   - 模型偶尔会包裹 ```json ... ``` → strip 围栏
 *   - 模型偶尔在 JSON 前后加散文 → 在第一个 `{` 与最后一个 `}` 之间截
 *   - 解析失败 → []
 *   - 非法 filename 过滤掉（防止幻觉文件名带入下游 readFile 报错）
 */
function parseSelectedFilenames(
  raw: string,
  validFilenames: ReadonlySet<string>,
): readonly string[] {
  const stripped = stripCodeFences(raw).trim();
  const openIndex = stripped.indexOf("{");
  const closeIndex = stripped.lastIndexOf("}");
  if (openIndex === -1 || closeIndex <= openIndex) return [];
  const jsonText = stripped.slice(openIndex, closeIndex + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const value = (parsed as { selected_memories?: unknown }).selected_memories;
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!validFilenames.has(item)) continue;
    out.push(item);
    if (out.length >= MAX_SELECTED) break;
  }
  return out;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstNl = trimmed.indexOf("\n");
  if (firstNl === -1) return trimmed;
  const body = trimmed.slice(firstNl + 1);
  const lastFenceIdx = body.lastIndexOf("```");
  return lastFenceIdx >= 0 ? body.slice(0, lastFenceIdx) : body;
}
