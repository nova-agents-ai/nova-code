/** M9 Skills 子系统的公共类型。 */

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly preambleTier?: number;
  readonly allowedTools?: readonly string[];
  readonly manualOnly: boolean;
}

export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly directory: string;
  readonly body: string;
  readonly metadata: SkillMetadata;
}

export interface SkillCatalog {
  readonly skills: readonly LoadedSkill[];
  readonly roots: readonly string[];
  readonly warnings: readonly string[];
}

export type SkillActivationReason = "explicit" | "keyword";

export interface SkillActivation {
  readonly skill: LoadedSkill;
  readonly reason: SkillActivationReason;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface SkillSelectionResult {
  readonly activations: readonly SkillActivation[];
  readonly instructions?: string;
}

export type SkillEnvironment = Readonly<Record<string, string | undefined>>;
