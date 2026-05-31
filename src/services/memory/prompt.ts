/**
 * Memory system prompt 装配。
 *
 * 对齐 claude-code/src/memdir/memdir.ts 的 buildMemoryLines + buildMemoryPrompt：
 *   - buildMemoryLines(memoryDir): 装配纯指令文案（4 type + how-to-save + when-to-access
 *     + before-recommending + memory-vs-persistence）
 *   - loadMemoryPrompt(memoryDir): 在上面基础上读 MEMORY.md 内容并拼装最终
 *     完整字符串，由 QueryEngine 注入 system prompt
 *
 * 设计要点：
 *   1. 单一事实源：所有文案段引用 promptText.ts 的常量；本文件只负责"拼接"。
 *   2. MEMORY.md 内容由 truncateEntrypointContent 双门截断（200 行 / 25KB）。
 *   3. MEMORY.md 不存在或空时给出降级文案："Your MEMORY.md is empty. When you
 *      save new memories, they will appear here."（与 claude-code 一致）
 *   4. 整段输出复用 `## 标题` 形式，由 QueryEngine 通过 mergeInstructionBlocks
 *      与其它 instruction blocks 拼装。
 */

import { MAX_ENTRYPOINT_LINES, truncateEntrypointContent } from "./entrypoint.ts";
import { ENTRYPOINT_NAME } from "./paths.ts";
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  PERSISTENCE_SECTION,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from "./promptText.ts";

/** 模型可见的 memory 系统标题。 */
const DISPLAY_NAME = "auto memory";

/**
 * 装配 memory system prompt 的指令段（不含 MEMORY.md 内容）。
 *
 * 调用方：
 *   - loadMemoryPrompt 内部在拼最终 prompt 时调
 *   - 测试：单独断言"指令段是否含 4 type / what-not-to-save / 等"
 */
export function buildMemoryLines(memoryDir: string): readonly string[] {
  return [
    `# ${DISPLAY_NAME}`,
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    "",
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    `**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:`,
    "",
    ...MEMORY_FRONTMATTER_EXAMPLE,
    "",
    `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    "",
    `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
    "",
    ...WHEN_TO_ACCESS_SECTION,
    "",
    ...TRUSTING_RECALL_SECTION,
    "",
    ...PERSISTENCE_SECTION,
  ];
}

/** 装配最终 system prompt 段（含 MEMORY.md 内容）。 */
export interface LoadMemoryPromptParams {
  readonly memoryDir: string;
  readonly entrypointPath: string;
}

/**
 * 读取 MEMORY.md 并装配完整 memory system prompt。
 *
 * 入口由 MemoryRuntime 包装（注入 memoryDir / entrypointPath）；本函数本身
 * 只做 IO + 拼接，便于单测注入虚拟路径。
 *
 * 找不到 MEMORY.md / 读取失败：拼"empty" 提示，不抛错。
 */
export async function loadMemoryPrompt(params: LoadMemoryPromptParams): Promise<string> {
  const lines = [...buildMemoryLines(params.memoryDir)];
  const raw = await readEntrypointSafely(params.entrypointPath);
  lines.push("");
  lines.push(`## ${ENTRYPOINT_NAME}`);
  lines.push("");
  if (raw.trim() === "") {
    lines.push(
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    );
  } else {
    const truncated = truncateEntrypointContent(raw);
    lines.push(truncated.content);
  }
  return lines.join("\n");
}

async function readEntrypointSafely(filePath: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch {
    return "";
  }
}
