/** Skill tool：按模型选择加载完整 SKILL.md 正文。 */

import {
  formatSkillInvocationContent,
  getModelInvocableSkills,
  type LoadedSkill,
} from "../../services/skills/index.ts";
import type { Tool } from "../../Tool.ts";
import { SKILL_TOOL_NAME } from "./constants.ts";

export function createSkillTool(skills: readonly LoadedSkill[]): Tool | undefined {
  const invocableSkills = getModelInvocableSkills(skills);
  if (invocableSkills.length === 0) return undefined;

  return {
    name: SKILL_TOOL_NAME,
    description: [
      "Execute a skill within the main conversation.",
      "When the user's request matches one of the available skills, call this tool with the skill name to load its full instructions.",
      "Available skills are listed in the system prompt. Do not guess skill names.",
      "If the user types /<skill-name>, treat it as a request to use that skill.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "The exact skill name to load. A leading slash is accepted and ignored.",
        },
        args: {
          type: "string",
          description: "Optional arguments supplied by the user for the skill.",
        },
      },
      required: ["skill"],
    },
    execute: (input) => executeSkillTool(input, invocableSkills),
  } satisfies Tool;
}

function executeSkillTool(
  input: Readonly<Record<string, unknown>>,
  skills: readonly LoadedSkill[],
): string {
  const skillName = parseSkillName(input["skill"]);
  const skill = findSkill(skills, skillName);
  if (skill === undefined) {
    throw new Error(
      `Unknown skill: ${skillName}. Available skills: ${formatAvailableSkills(skills)}`,
    );
  }

  const args = typeof input["args"] === "string" ? input["args"] : undefined;
  return formatSkillInvocationContent(skill, args);
}

function parseSkillName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Skill name must be a string.");
  }

  const trimmed = value.trim();
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  if (normalized === "") {
    throw new Error("Skill name must not be empty.");
  }
  return normalized;
}

function findSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
  const normalized = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === normalized);
}

function formatAvailableSkills(skills: readonly LoadedSkill[]): string {
  return skills.map((skill) => skill.name).join(", ");
}
