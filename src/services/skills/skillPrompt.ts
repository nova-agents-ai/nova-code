/** M9 Skills prompt 注入格式。 */

import type { LoadedSkill } from "./types.ts";

export const SKILL_LISTING_HEADER =
  "The following skills are available for use with the Skill tool:";

export const SKILL_TOOL_GUIDANCE = [
  "Available skills are listed below. Skills provide specialized capabilities and domain knowledge.",
  "When a skill matches the user's request, use the Skill tool to load that skill before giving the final answer.",
  "When users reference a slash command like /<skill-name>, treat it as a request to use that skill.",
  "Only use skills listed here; do not guess skill names.",
].join("\n");

const MAX_LISTING_DESC_CHARS = 250;
const DEFAULT_LISTING_CHAR_BUDGET = 8_000;

export function formatSkillListingInstructions(skills: readonly LoadedSkill[]): string | undefined {
  const listing = formatSkillsWithinBudget(getModelInvocableSkills(skills));
  if (listing === "") return undefined;
  return [SKILL_TOOL_GUIDANCE, SKILL_LISTING_HEADER, listing].join("\n\n");
}

export function getModelInvocableSkills(skills: readonly LoadedSkill[]): readonly LoadedSkill[] {
  return skills.filter(isModelInvocableSkill);
}

export function isModelInvocableSkill(skill: LoadedSkill): boolean {
  return !skill.metadata.disableModelInvocation;
}

export function formatSkillsWithinBudget(
  skills: readonly LoadedSkill[],
  charBudget: number = DEFAULT_LISTING_CHAR_BUDGET,
): string {
  if (skills.length === 0) return "";

  const fullEntries = skills.map(formatSkillListingEntry);
  const fullText = fullEntries.join("\n");
  if (fullText.length <= charBudget) return fullText;

  const namesOnly = skills.map((skill) => `- ${skill.name}`).join("\n");
  const availableForDescriptions = charBudget - namesOnly.length - skills.length * 2;
  const maxDescriptionLength = Math.floor(availableForDescriptions / skills.length);
  if (maxDescriptionLength < 20) return namesOnly;

  return skills
    .map(
      (skill) =>
        `- ${skill.name}: ${truncateInline(getSkillDescription(skill), maxDescriptionLength)}`,
    )
    .join("\n");
}

export function formatSkillInvocationContent(skill: LoadedSkill, args?: string): string {
  const rawContent = [`Base directory for this skill: ${skill.directory}`, "", skill.body].join(
    "\n",
  );
  if (args === undefined || args.trim() === "") return rawContent;
  return rawContent.replaceAll("$ARGUMENTS", args);
}

export function mergeInstructionBlocks(
  ...blocks: readonly (string | undefined)[]
): string | undefined {
  const merged = blocks.map((block) => block?.trim()).filter(isNonEmptyString);
  return merged.length === 0 ? undefined : merged.join("\n\n");
}

function formatSkillListingEntry(skill: LoadedSkill): string {
  return `- ${skill.name}: ${truncateInline(getSkillDescription(skill), MAX_LISTING_DESC_CHARS)}`;
}

function getSkillDescription(skill: LoadedSkill): string {
  return skill.metadata.whenToUse === undefined || skill.metadata.whenToUse === ""
    ? skill.description
    : `${skill.description} - ${skill.metadata.whenToUse}`;
}

function truncateInline(content: string, maxChars: number): string {
  const normalized = content.replaceAll("\n", " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}
