/** M9 Skills 自动激活：显式触发优先，非 manual-only skill 再做轻量关键词匹配。 */

import type { LoadedSkill, SkillActivation } from "./types.ts";

export interface SelectSkillsParams {
  readonly skills: readonly LoadedSkill[];
  readonly query: string;
  readonly maxSkills?: number;
}

interface Candidate {
  readonly activation: SkillActivation;
  readonly order: number;
}

const DEFAULT_MAX_SKILLS = 3;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "when",
  "what",
  "how",
  "why",
  "code",
  "skill",
  "skills",
  "best",
  "practices",
  "manual",
  "trigger",
  "only",
  "use",
  "using",
  "开发",
  "代码",
  "实现",
  "系统",
]);

export function selectSkills(params: SelectSkillsParams): readonly SkillActivation[] {
  const queryTokens = tokenize(params.query);
  const queryTokenSet = new Set(queryTokens);
  const candidates = params.skills
    .map((skill, index) => buildCandidate(skill, params.query, queryTokenSet, index))
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .sort(compareCandidates);
  return candidates.slice(0, params.maxSkills ?? DEFAULT_MAX_SKILLS).map((item) => item.activation);
}

function buildCandidate(
  skill: LoadedSkill,
  query: string,
  queryTokens: ReadonlySet<string>,
  order: number,
): Candidate | undefined {
  const explicit = findExplicitTrigger(skill.name, query);
  if (explicit !== undefined) {
    return {
      order,
      activation: { skill, reason: "explicit", score: 100, matchedTerms: [explicit] },
    };
  }

  if (skill.metadata.manualOnly) return undefined;

  const keyword = scoreKeywordMatch(skill, queryTokens);
  if (keyword.score <= 0) return undefined;
  return {
    order,
    activation: {
      skill,
      reason: "keyword",
      score: keyword.score,
      matchedTerms: keyword.matchedTerms,
    },
  };
}

function findExplicitTrigger(skillName: string, query: string): string | undefined {
  const escaped = escapeRegExp(skillName);
  const patterns = [
    new RegExp(`(?:^|\\s)/${escaped}(?=\\s|$)`, "i"),
    new RegExp(`(?:^|\\s)\\$${escaped}(?=\\s|$)`, "i"),
    new RegExp(`(?:^|\\s)skill:${escaped}(?=\\s|$)`, "i"),
  ];
  if (patterns.some((pattern) => pattern.test(query))) return skillName;
  return undefined;
}

function scoreKeywordMatch(
  skill: LoadedSkill,
  queryTokens: ReadonlySet<string>,
): { readonly score: number; readonly matchedTerms: readonly string[] } {
  const nameTokens = tokenize(skill.name);
  const descriptorTokens = tokenize(`${skill.name} ${skill.description}`);
  const matched = descriptorTokens.filter((token) => queryTokens.has(token));
  const uniqueMatched = [...new Set(matched)];

  let score = uniqueMatched.length;
  if (nameTokens.some((token) => token.length >= 4 && queryTokens.has(token))) score += 2;
  if (queryTokens.has(skill.name.toLowerCase())) score += 3;

  const shouldActivate = score >= 2 || hasExactShortNameMatch(skill.name, queryTokens);
  return {
    score: shouldActivate ? score : 0,
    matchedTerms: uniqueMatched,
  };
}

function hasExactShortNameMatch(skillName: string, queryTokens: ReadonlySet<string>): boolean {
  const normalized = skillName.toLowerCase();
  return normalized.length >= 2 && normalized.length <= 6 && queryTokens.has(normalized);
}

function tokenize(content: string): readonly string[] {
  const lower = content.toLowerCase();
  const matches = lower.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return matches
    .flatMap((token) => token.split(/[_-]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.activation.reason !== b.activation.reason) {
    return a.activation.reason === "explicit" ? -1 : 1;
  }
  if (a.activation.score !== b.activation.score) return b.activation.score - a.activation.score;
  return a.order - b.order;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
