/** M9 Skills prompt 注入格式。 */

import type { SkillActivation } from "./types.ts";

export const SKILL_INSTRUCTIONS_HEADER =
  "Activated skill instructions are shown below. Use them when they are relevant to the current user request. " +
  "Project/user instructions still take precedence if they conflict.";

const MAX_CHARS_PER_SKILL = 24_000;
const MAX_TOTAL_CHARS = 60_000;

export function formatSkillInstructions(
  activations: readonly SkillActivation[],
): string | undefined {
  if (activations.length === 0) return undefined;

  const sections: string[] = [SKILL_INSTRUCTIONS_HEADER];
  let totalChars = SKILL_INSTRUCTIONS_HEADER.length;
  for (const activation of activations) {
    const section = formatSkillSection(activation);
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) break;
    const bounded =
      section.length > remaining ? `${section.slice(0, remaining)}\n[truncated]` : section;
    sections.push(bounded);
    totalChars += bounded.length;
  }

  return sections.join("\n\n");
}

export function mergeInstructionBlocks(
  ...blocks: readonly (string | undefined)[]
): string | undefined {
  const merged = blocks.map((block) => block?.trim()).filter(isNonEmptyString);
  return merged.length === 0 ? undefined : merged.join("\n\n");
}

function formatSkillSection(activation: SkillActivation): string {
  const { skill } = activation;
  const body = truncate(skill.body, MAX_CHARS_PER_SKILL);
  const matched = activation.matchedTerms.length > 0 ? activation.matchedTerms.join(", ") : "n/a";
  return [
    `## Skill: ${skill.name}`,
    `Description: ${skill.description || "(none)"}`,
    `Activation: ${activation.reason}; matched: ${matched}`,
    `Source: ${skill.path}`,
    "",
    body,
  ].join("\n");
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[truncated]`;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}
