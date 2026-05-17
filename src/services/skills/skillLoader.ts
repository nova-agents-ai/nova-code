/** M9 Skills 加载器：扫描 skill roots，读取 SKILL.md，并构造可匹配目录。 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseSkillDocument } from "./frontmatter.ts";
import type { LoadedSkill, SkillCatalog, SkillEnvironment, SkillMetadata } from "./types.ts";

const PROJECT_SKILLS_DIR = ".nova-code/skills";
const USER_NOVA_SKILLS_DIR = ".nova-code/skills";
const USER_AGENTS_SKILLS_DIR = ".agents/skills";
const SKILL_FILE_NAME = "SKILL.md";
const ENV_DISABLE_SKILLS = "NOVA_DISABLE_SKILLS";
const ENV_SKILL_DIRS = "NOVA_SKILL_DIRS";
const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface LoadSkillCatalogParams {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly env?: SkillEnvironment;
}

export async function loadSkillCatalog(params: LoadSkillCatalogParams): Promise<SkillCatalog> {
  const env = params.env ?? process.env;
  const roots = resolveSkillRoots({ ...params, env });
  const warnings: string[] = [];
  const skills: LoadedSkill[] = [];
  const seenNames = new Set<string>();

  for (const root of roots) {
    const files = await findSkillFiles(root, warnings);
    for (const filePath of files) {
      const loaded = await loadSkillFile(filePath);
      if (loaded.skill === undefined) {
        warnings.push(loaded.warning);
        continue;
      }
      const key = loaded.skill.name.toLowerCase();
      if (seenNames.has(key)) {
        warnings.push(`duplicate skill '${loaded.skill.name}' skipped: ${filePath}`);
        continue;
      }
      seenNames.add(key);
      skills.push(loaded.skill);
    }
  }

  return { roots, skills: sortSkills(skills), warnings };
}

export function resolveSkillRoots(params: LoadSkillCatalogParams): readonly string[] {
  const env = params.env ?? process.env;
  if (isTruthy(env[ENV_DISABLE_SKILLS])) return [];

  const home = params.homeDir ?? homedir();
  const configured = env[ENV_SKILL_DIRS];
  if (configured !== undefined && configured.trim() !== "") {
    return uniqueRoots(
      configured.split(",").map((item) => normalizeRoot(item.trim(), params.cwd, home)),
    );
  }

  return uniqueRoots([
    resolve(params.cwd, PROJECT_SKILLS_DIR),
    join(home, USER_NOVA_SKILLS_DIR),
    join(home, USER_AGENTS_SKILLS_DIR),
  ]);
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeRoot(value: string, cwd: string, home: string): string {
  if (value === "") return "";
  const expanded = value === "~" ? home : value.replace(/^~\//, `${home}/`);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function uniqueRoots(roots: readonly string[]): readonly string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (root === "" || seen.has(root)) continue;
    seen.add(root);
    unique.push(root);
  }
  return unique;
}

async function findSkillFiles(root: string, warnings: string[]): Promise<readonly string[]> {
  if (!(await pathExists(root))) return [];

  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    warnings.push(`failed to scan skills root ${root}: ${describeError(error)}`);
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    files.push(join(root, entry.name, SKILL_FILE_NAME));
  }

  const existingFiles: string[] = [];
  for (const file of files) {
    if (await pathExists(file)) existingFiles.push(file);
  }

  return existingFiles.sort((a, b) => a.localeCompare(b));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadSkillFile(
  filePath: string,
): Promise<
  { readonly skill: LoadedSkill } | { readonly warning: string; readonly skill?: undefined }
> {
  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch (error) {
    return { warning: `failed to read skill ${filePath}: ${describeError(error)}` };
  }

  const document = parseSkillDocument(content);
  const metadata = buildMetadata(document.frontmatter, filePath, document.body);
  if (metadata === undefined) {
    return { warning: `invalid skill name in ${filePath}` };
  }

  return {
    skill: {
      name: metadata.name,
      description: metadata.description,
      path: filePath,
      directory: dirname(filePath),
      body: document.body,
      metadata,
    },
  };
}

function buildMetadata(
  frontmatter: Readonly<Record<string, unknown>>,
  filePath: string,
  body: string,
): SkillMetadata | undefined {
  const name = basename(dirname(filePath));
  if (!SKILL_NAME_PATTERN.test(name)) return undefined;

  const description = asNonEmptyString(frontmatter["description"]) ?? firstNonEmptyLine(body) ?? "";
  const version = asNonEmptyString(frontmatter["version"]);
  const preambleTier = asNumber(frontmatter["preamble-tier"]);
  const allowedTools = asStringArray(frontmatter["allowed-tools"]);
  const whenToUse = asNonEmptyString(frontmatter["when_to_use"]);
  const disableModelInvocation = asBoolean(frontmatter["disable-model-invocation"]);
  const manualOnly = isManualOnly(description) || isManualOnly(body);

  return {
    name,
    description,
    disableModelInvocation,
    manualOnly,
    ...(version !== undefined ? { version } : {}),
    ...(preambleTier !== undefined ? { preambleTier } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function firstNonEmptyLine(content: string): string | undefined {
  return content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function isManualOnly(content: string): boolean {
  return content.toLowerCase().includes("manual trigger only");
}

function sortSkills(skills: readonly LoadedSkill[]): readonly LoadedSkill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
