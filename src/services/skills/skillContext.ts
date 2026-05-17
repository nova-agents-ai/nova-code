/** M9 Skills 运行时上下文：load → select → format，一次性给 ask/chat 复用。 */

import { type LoadSkillCatalogParams, loadSkillCatalog } from "./skillLoader.ts";
import { selectSkills } from "./skillMatcher.ts";
import { formatSkillInstructions } from "./skillPrompt.ts";
import type { LoadedSkill, SkillCatalog, SkillSelectionResult } from "./types.ts";

export interface GetSkillInstructionsParams extends LoadSkillCatalogParams {
  readonly prompt: string;
  readonly maxSkills?: number;
}

export async function getSkillInstructionsForPrompt(
  params: GetSkillInstructionsParams,
): Promise<SkillSelectionResult & { readonly catalog: SkillCatalog }> {
  const catalog = await loadSkillCatalog(params);
  const selection = getSkillInstructionsFromCatalog({
    skills: catalog.skills,
    prompt: params.prompt,
    ...(params.maxSkills !== undefined ? { maxSkills: params.maxSkills } : {}),
  });
  return { ...selection, catalog };
}

export function getSkillInstructionsFromCatalog(params: {
  readonly skills: readonly LoadedSkill[];
  readonly prompt: string;
  readonly maxSkills?: number;
}): SkillSelectionResult {
  const activations = selectSkills({
    skills: params.skills,
    query: params.prompt,
    ...(params.maxSkills !== undefined ? { maxSkills: params.maxSkills } : {}),
  });
  return { activations, instructions: formatSkillInstructions(activations) };
}
