/** 用户显式 `/skill args` 调用的本地展开逻辑。 */

import { formatSkillInvocationContent } from "./skillPrompt.ts";
import type { LoadedSkill } from "./types.ts";

export type SkillSlashInvocationResult =
  | {
      readonly kind: "invoke";
      readonly skill: LoadedSkill;
      readonly args: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "blocked";
      readonly skill: LoadedSkill;
      readonly message: string;
    };

interface ParsedSlashInvocation {
  readonly name: string;
  readonly args: string;
}

export function resolveSkillSlashInvocation(
  input: string,
  skills: readonly LoadedSkill[] | undefined,
): SkillSlashInvocationResult | undefined {
  if (skills === undefined) return undefined;
  const parsed = parseSkillSlashInvocation(input);
  if (parsed === undefined) return undefined;

  const skill = findSkill(skills, parsed.name);
  if (skill === undefined) return undefined;
  if (!skill.metadata.userInvocable) {
    return {
      kind: "blocked",
      skill,
      message: `Skill ${skill.name} can only be invoked by the model, not directly by users.`,
    };
  }

  return {
    kind: "invoke",
    skill,
    args: parsed.args,
    prompt: formatSkillSlashPrompt(skill, parsed.args),
  };
}

function parseSkillSlashInvocation(input: string): ParsedSlashInvocation | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return undefined;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  if (rawName === undefined || rawName === "") return undefined;
  return { name: rawName, args: rest.join(" ") };
}

function findSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
  const normalized = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === normalized);
}

function formatSkillSlashPrompt(skill: LoadedSkill, args: string): string {
  const argumentBlock = args.trim() === "" ? "(none)" : args;
  return [
    `The user directly invoked the "${skill.name}" skill.`,
    `The skill content has already been loaded locally; do not call the Skill tool for "${skill.name}" again for this invocation.`,
    "",
    "Arguments:",
    argumentBlock,
    "",
    "Skill content:",
    formatSkillInvocationContent(skill, args),
  ].join("\n");
}
