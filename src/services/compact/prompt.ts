/**
 * Compact 提示词模板与 summary 解析。
 *
 * 对齐 claude-code/src/services/compact/prompt.ts。本文件几乎按字逐句复刻 claude-code
 * 的两套模板（BASE / PARTIAL）以及 NO_TOOLS_PREAMBLE / TRAILER —— 模型在这套提示词上
 * 已经训练充分，自定义反而会降低 summary 质量。
 *
 * 与 claude-code 的差异：
 * - PARTIAL_COMPACT_UP_TO_PROMPT 暂未导出（M4 partialCompact 仅用 from 方向，
 *   即"summary 放在尾部、保留前缀"。Phase 2 reactiveCompact 才需要 up_to）
 * - getPartialCompactPrompt 的 direction 参数被简化为只接受 "from"
 */

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — " +
  "an <analysis> block followed by a <summary> block. " +
  "Tool calls will be rejected and you will fail the task.";

const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Wrap your analysis in <analysis> tags and your final summary in <summary> tags. The <analysis> block is a drafting scratchpad and will be stripped before the summary is reused.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Wrap your analysis in <analysis> tags and your final summary in <summary> tags.

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.`;

/**
 * 主 compact 路径使用的提示词。会被包成一条 user message 追加到原对话末尾，
 * 模型据此输出 <summary>...</summary>。
 *
 * customInstructions 用于 /compact "<extra hint>" 等用户自定义指令场景。
 */
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT;
  if (customInstructions !== undefined && customInstructions.trim() !== "") {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }
  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

/**
 * partialCompact 路径使用的提示词。语义同上，但范围限定在"被压缩的前缀"，
 * 因为尾部消息会以原文形式保留，不进入 summary。
 */
export function getPartialCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + PARTIAL_COMPACT_PROMPT;
  if (customInstructions !== undefined && customInstructions.trim() !== "") {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }
  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

/**
 * 把模型返回的"<analysis>...</analysis><summary>...</summary>"原文格式化为
 * 可塞回上下文的 summary 字符串：
 *  - 删去 <analysis> 段（仅是模型的草稿区）
 *  - 把 <summary> ... </summary> 替换成 "Summary:\n..." 易读的形态
 *  - 清理多余空行
 *
 * 对齐 claude-code/src/services/compact/prompt.ts:311（formatCompactSummary）。
 */
export function formatCompactSummary(rawSummary: string): string {
  let formatted = rawSummary;

  // 1. strip <analysis>...</analysis>（首个匹配即可；模型应只产一段 analysis）
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, "");

  // 2. extract <summary>...</summary>，替换成 "Summary:\n..."
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const inner = summaryMatch[1] ?? "";
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${inner.trim()}`);
  }

  // 3. 多重空行折叠成单空行
  formatted = formatted.replace(/\n\n+/g, "\n\n");

  return formatted.trim();
}

/**
 * 构造 compact 完成后塞回上下文的 user message 文本。
 *
 * 对齐 claude-code/src/services/compact/prompt.ts:337（getCompactUserSummaryMessage）。
 *
 * @param summary 原始 summary 文本（含 <analysis> / <summary> 标签）
 * @param suppressFollowUpQuestions auto-compact 时为 true：让模型继续之前的工作，
 *        不要寒暄或问"接下来想做什么"。手动 /compact 时为 false。
 * @param recentMessagesPreserved partialCompact 时为 true：通知模型"summary 之后还有原文消息"，
 *        让它优先利用原文细节而不是仅依赖 summary。
 */
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions: boolean,
  recentMessagesPreserved: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary);

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`;

  if (recentMessagesPreserved) {
    baseSummary += "\n\nRecent messages are preserved verbatim.";
  }

  if (suppressFollowUpQuestions) {
    return `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`;
  }

  return baseSummary;
}
