/**
 * AgentTool（name: "Agent"）—— 派生一个独立子 agent 处理子任务。
 *
 * M11 的实现刻意收敛为同步 one-shot 子 agent：父 agent 发起工具调用后等待子
 * agent 完成，只把最终摘要作为 tool_result 回传给父 agent，不把子 agent 的中间
 * tool noise 注入父上下文。
 */

import type { SubAgentRunParams, Tool } from "../../Tool.ts";
import { AGENT_TOOL_NAME, SubAgentTypeEnum } from "./constants.ts";

const MAX_DESCRIPTION_CHARS = 120;
const MAX_PROMPT_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 30_000;

interface ParsedAgentToolInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagentType?: SubAgentTypeEnum;
}

export const AgentTool: Tool = {
  name: AGENT_TOOL_NAME,
  description:
    "Launch a sub-agent to handle an independent research or implementation task. " +
    "Use it when intermediate tool output would otherwise flood the main context; " +
    "the main agent only receives the sub-agent's final summary.",
  input_schema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short 3-8 word description of the delegated task.",
      },
      prompt: {
        type: "string",
        description:
          "A complete briefing for the sub-agent. Include scope, context, constraints, and expected output.",
      },
      subagent_type: {
        type: "string",
        enum: [SubAgentTypeEnum.GENERAL_PURPOSE, SubAgentTypeEnum.EXPLORE, SubAgentTypeEnum.PLAN],
        description:
          "Optional sub-agent type. Use explore for read-only research, plan for read-only implementation planning, or omit for general-purpose work.",
      },
    },
    required: ["description", "prompt"],
  },
  requiresApproval: false,
  execute: async (input, context) => {
    const runtime = context.subAgentRuntime;
    if (runtime === undefined) {
      throw new Error("Agent runtime is not available in this execution context.");
    }

    const parsed = parseAgentToolInput(input);
    const result = await runtime.run(toSubAgentRunParams(parsed));
    return formatAgentToolResult(result.agentType, result.turns, result.summary);
  },
};

function parseAgentToolInput(input: Readonly<Record<string, unknown>>): ParsedAgentToolInput {
  const description = parseBoundedString(input["description"], "description", {
    maxChars: MAX_DESCRIPTION_CHARS,
  });
  const prompt = parseBoundedString(input["prompt"], "prompt", { maxChars: MAX_PROMPT_CHARS });
  const rawType = input["subagent_type"];
  if (rawType === undefined) return { description, prompt };
  if (
    rawType === SubAgentTypeEnum.GENERAL_PURPOSE ||
    rawType === SubAgentTypeEnum.EXPLORE ||
    rawType === SubAgentTypeEnum.PLAN
  ) {
    return { description, prompt, subagentType: rawType };
  }
  throw new Error(
    `Agent input field 'subagent_type' must be '${SubAgentTypeEnum.GENERAL_PURPOSE}', '${SubAgentTypeEnum.EXPLORE}', or '${SubAgentTypeEnum.PLAN}'.`,
  );
}

function parseBoundedString(
  value: unknown,
  field: string,
  bounds: { readonly maxChars: number },
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Agent input field '${field}' must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > bounds.maxChars) {
    throw new Error(`Agent input field '${field}' must be at most ${bounds.maxChars} characters.`);
  }
  return trimmed;
}

function toSubAgentRunParams(input: ParsedAgentToolInput): SubAgentRunParams {
  return {
    description: input.description,
    prompt: input.prompt,
    ...(input.subagentType !== undefined ? { subagentType: input.subagentType } : {}),
  };
}

function formatAgentToolResult(agentType: string, turns: number, summary: string): string {
  const trimmedSummary =
    summary.trim() === "" ? "(sub-agent completed without text output)" : summary;
  return [
    `Sub-agent completed (type: ${agentType}, turns: ${turns}).`,
    "",
    truncateSummary(trimmedSummary),
  ].join("\n");
}

function truncateSummary(value: string): string {
  if (value.length <= MAX_SUMMARY_CHARS) return value;
  return `${value.slice(0, MAX_SUMMARY_CHARS)}\n[truncated: sub-agent summary exceeded ${MAX_SUMMARY_CHARS} characters]`;
}
