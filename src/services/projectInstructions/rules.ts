/** M12 `.claude/rules` runtime: eager rules + path-scoped activation. */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { executeHookBatch } from "../hooks/hookRunner.ts";
import { HookEventName, type HooksConfig, type InstructionsLoadReason } from "../hooks/types.ts";
import type { PluginRuleContribution } from "../plugins/types.ts";
import {
  formatInstructionFiles,
  type GetProjectInstructionsParams,
  type LoadedInstructionFile,
  loadBaseInstructionFiles,
  loadFileWithIncludes,
} from "./claudeMd.ts";
import { findGitRoot, getDirectoryChain } from "./pathDiscovery.ts";

export interface CreateProjectInstructionsRuntimeParams extends GetProjectInstructionsParams {
  /** M10/M12：InstructionsLoaded audit hook 配置。 */
  readonly hooks?: HooksConfig;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  /** M13：enabled plugins 提供的 instruction fragment/rules 目录。 */
  readonly pluginRuleContributions?: readonly PluginRuleContribution[];
}

export interface ActivateProjectRulesParams {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export interface ActivateProjectRulesForPathParams {
  readonly path: string;
  readonly cwd: string;
}

export interface ProjectRuleActivation {
  readonly path: string;
  readonly triggerFilePath: string;
  readonly globs: readonly string[];
}

export interface ProjectInstructionsRuntime {
  readonly getInstructions: () => string | undefined;
  readonly activateForToolUse: (
    params: ActivateProjectRulesParams,
  ) => Promise<readonly ProjectRuleActivation[]>;
  readonly activateForPath: (
    params: ActivateProjectRulesForPathParams,
  ) => Promise<readonly ProjectRuleActivation[]>;
}

interface ProjectRuleFile {
  readonly path: string;
  readonly baseDir: string;
  readonly globs: readonly string[];
  readonly files: readonly LoadedInstructionFile[];
}

export async function createProjectInstructionsRuntime(
  params: CreateProjectInstructionsRuntimeParams,
): Promise<ProjectInstructionsRuntime> {
  const loaded = await loadBaseInstructionFiles(params);
  const eagerRules = await loadEagerProjectRules(params);
  const eagerPluginRules = await loadPluginRules(params, false);
  const conditionalRules = await loadConditionalProjectRules(params);
  const conditionalPluginRules = await loadPluginRules(params, true);
  const runtime = new DefaultProjectInstructionsRuntime(
    [
      ...loaded,
      ...eagerRules.flatMap((rule) => rule.files),
      ...eagerPluginRules.flatMap((rule) => rule.files),
    ],
    [...conditionalRules, ...conditionalPluginRules],
    params,
  );

  await runtime.fireLoadedHooksForBaseFiles();
  return runtime;
}

class DefaultProjectInstructionsRuntime implements ProjectInstructionsRuntime {
  private readonly baseFiles: readonly LoadedInstructionFile[];
  private readonly conditionalRules: readonly ProjectRuleFile[];
  private readonly activeRulePaths = new Set<string>();
  private readonly params: CreateProjectInstructionsRuntimeParams;

  constructor(
    baseFiles: readonly LoadedInstructionFile[],
    conditionalRules: readonly ProjectRuleFile[],
    params: CreateProjectInstructionsRuntimeParams,
  ) {
    this.baseFiles = baseFiles;
    this.conditionalRules = conditionalRules;
    this.params = params;
  }

  getInstructions(): string | undefined {
    const activeFiles = this.conditionalRules
      .filter((rule) => this.activeRulePaths.has(rule.path))
      .flatMap((rule) => rule.files);
    const files = [...this.baseFiles, ...activeFiles];
    return files.length === 0 ? undefined : formatInstructionFiles(files);
  }

  async activateForToolUse(
    params: ActivateProjectRulesParams,
  ): Promise<readonly ProjectRuleActivation[]> {
    const triggerPath = extractInstructionTriggerPath(params);
    if (triggerPath === undefined) return [];

    return await this.activateForPath({ path: triggerPath, cwd: params.cwd });
  }

  async activateForPath(
    params: ActivateProjectRulesForPathParams,
  ): Promise<readonly ProjectRuleActivation[]> {
    const absoluteTriggerPath = resolveToolPath(params.path, params.cwd);
    const activated: ProjectRuleActivation[] = [];
    for (const rule of this.conditionalRules) {
      if (this.activeRulePaths.has(rule.path)) continue;
      if (!matchesRuleGlobs(rule, absoluteTriggerPath)) continue;
      this.activeRulePaths.add(rule.path);
      const activation = {
        path: rule.path,
        triggerFilePath: absoluteTriggerPath,
        globs: rule.globs,
      };
      activated.push(activation);
      await this.fireLoadedHooksForRule(rule, absoluteTriggerPath);
    }
    return activated;
  }

  async fireLoadedHooksForBaseFiles(): Promise<void> {
    if (!hasInstructionsLoadedHook(this.params.hooks)) return;
    for (const file of this.baseFiles) {
      const loadReason: InstructionsLoadReason =
        file.parent === undefined ? "session_start" : "include";
      await executeInstructionsLoadedHook({
        params: this.params,
        file,
        loadReason,
      });
    }
  }

  private async fireLoadedHooksForRule(
    rule: ProjectRuleFile,
    triggerFilePath: string,
  ): Promise<void> {
    if (!hasInstructionsLoadedHook(this.params.hooks)) return;
    for (const file of rule.files) {
      const loadReason: InstructionsLoadReason =
        file.parent === undefined ? "path_glob_match" : "include";
      await executeInstructionsLoadedHook({
        params: this.params,
        file,
        loadReason,
        triggerFilePath,
      });
    }
  }
}

async function loadEagerProjectRules(
  params: GetProjectInstructionsParams,
): Promise<readonly ProjectRuleFile[]> {
  const dirChain = await getProjectDirectoryChain(params.cwd);
  const rules: ProjectRuleFile[] = [];
  const visited = new Set<string>();
  for (const dir of dirChain) {
    rules.push(...(await loadProjectRulesForDirectory(dir, false, visited)));
  }
  return rules;
}

async function loadConditionalProjectRules(
  params: GetProjectInstructionsParams,
): Promise<readonly ProjectRuleFile[]> {
  const dirChain = await getProjectDirectoryChain(params.cwd);
  const rules: ProjectRuleFile[] = [];
  for (const dir of dirChain) {
    const visited = new Set<string>();
    const dirRules = await loadProjectRulesForDirectory(dir, true, visited);
    rules.push(...dirRules);
  }
  return rules;
}

async function getProjectDirectoryChain(cwd: string): Promise<readonly string[]> {
  const gitRoot = await findGitRoot(cwd);
  return getDirectoryChain(cwd, gitRoot);
}

async function loadProjectRulesForDirectory(
  dir: string,
  conditionalRule: boolean,
  visited: Set<string>,
): Promise<readonly ProjectRuleFile[]> {
  const rulesDir = join(dir, ".claude", "rules");
  return await loadRulesFromPath({ rulesPath: rulesDir, baseDir: dir, conditionalRule, visited });
}

async function loadPluginRules(
  params: CreateProjectInstructionsRuntimeParams,
  conditionalRule: boolean,
): Promise<readonly ProjectRuleFile[]> {
  const rules: ProjectRuleFile[] = [];
  const visited = new Set<string>();
  for (const contribution of params.pluginRuleContributions ?? []) {
    rules.push(
      ...(await loadRulesFromPath({
        rulesPath: contribution.rulesPath,
        baseDir: contribution.baseDir,
        conditionalRule,
        visited,
      })),
    );
  }
  return rules;
}

async function loadRulesFromPath(params: {
  readonly rulesPath: string;
  readonly baseDir: string;
  readonly conditionalRule: boolean;
  readonly visited: Set<string>;
}): Promise<readonly ProjectRuleFile[]> {
  const { rulesPath, baseDir, conditionalRule, visited } = params;
  const rulePaths = await findRuleMarkdownFiles(rulesPath);
  const rules: ProjectRuleFile[] = [];

  for (const rulePath of rulePaths) {
    const globs = await readRulePathGlobs(rulePath);
    const isConditional = globs.length > 0;
    if (conditionalRule !== isConditional) continue;
    const files: LoadedInstructionFile[] = [];
    const ruleVisited = conditionalRule ? new Set<string>() : visited;
    await loadFileWithIncludes({
      filePath: rulePath,
      loaded: files,
      visited: ruleVisited,
      depth: 0,
      memoryType: "Project",
      stripFrontmatter: true,
      ...(isConditional ? { globs } : {}),
    });
    if (files.length === 0) continue;
    rules.push({ path: resolve(rulePath), baseDir, globs, files });
  }

  return rules;
}

async function findRuleMarkdownFiles(rulesDir: string): Promise<readonly string[]> {
  const stats = await safeStat(rulesDir);
  if (stats === undefined) return [];
  if (stats.isFile()) return rulesDir.endsWith(".md") ? [rulesDir] : [];
  if (!stats.isDirectory()) return [];

  let entries: Dirent<string>[];
  try {
    entries = await readdir(rulesDir, { withFileTypes: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return [];
    throw error;
  }

  const files: string[] = [];
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sortedEntries) {
    const entryPath = join(rulesDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRuleMarkdownFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function readRulePathGlobs(rulePath: string): Promise<readonly string[]> {
  try {
    const raw = await Bun.file(rulePath).text();
    return parseRulePathGlobs(raw);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return [];
    throw error;
  }
}

function parseRulePathGlobs(content: string): readonly string[] {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === undefined) return [];
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parsePathsFrontmatterLine(lines, i);
    if (parsed !== undefined) return parsed;
  }
  return [];
}

function parsePathsFrontmatterLine(
  lines: readonly string[],
  index: number,
): readonly string[] | undefined {
  const line = lines[index] ?? "";
  const match = /^paths:\s*(.*)$/.exec(line.trim());
  const value = match?.[1];
  if (value === undefined) return undefined;
  if (value !== "") return parseInlinePathsValue(value);
  const values: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const item = /^\s*-\s*(.*)$/.exec(lines[i] ?? "");
    if (item === null) break;
    const valueText = item[1]?.trim() ?? "";
    if (valueText !== "") values.push(unquoteYamlScalar(valueText));
  }
  return values;
}

function parseInlinePathsValue(value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((item) => unquoteYamlScalar(item.trim()))
      .filter((item) => item !== "");
  }
  return [unquoteYamlScalar(trimmed)].filter((item) => item !== "");
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function extractFrontmatter(content: string): string | undefined {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      return lines.slice(1, i).join("\n");
    }
  }
  return undefined;
}

function extractInstructionTriggerPath(params: ActivateProjectRulesParams): string | undefined {
  if (
    params.toolName !== "FileRead" &&
    params.toolName !== "FileEdit" &&
    params.toolName !== "FileWrite"
  ) {
    return undefined;
  }
  const path = params.input["path"];
  return typeof path === "string" && path !== "" ? path : undefined;
}

function resolveToolPath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function matchesRuleGlobs(rule: ProjectRuleFile, absoluteTargetPath: string): boolean {
  const relativePath = relative(rule.baseDir, absoluteTargetPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return false;
  }
  const normalizedPath = relativePath.split(sep).join("/");
  return rule.globs.some((glob) => new Bun.Glob(normalizeRuleGlob(glob)).match(normalizedPath));
}

function normalizeRuleGlob(glob: string): string {
  const normalized = glob.trim().replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function hasInstructionsLoadedHook(hooks: HooksConfig | undefined): boolean {
  return (hooks?.[HookEventName.INSTRUCTIONS_LOADED]?.length ?? 0) > 0;
}

async function executeInstructionsLoadedHook(params: {
  readonly params: CreateProjectInstructionsRuntimeParams;
  readonly file: LoadedInstructionFile;
  readonly loadReason: InstructionsLoadReason;
  readonly triggerFilePath?: string;
}): Promise<void> {
  await executeHookBatch({
    config: params.params.hooks,
    event: HookEventName.INSTRUCTIONS_LOADED,
    cwd: params.params.cwd,
    signal: params.params.signal ?? new AbortController().signal,
    input: {
      hook_event_name: HookEventName.INSTRUCTIONS_LOADED,
      session_id: params.params.sessionId ?? "unknown",
      cwd: params.params.cwd,
      file_path: params.file.path,
      memory_type: params.file.memoryType,
      load_reason: params.loadReason,
      ...(params.file.globs !== undefined ? { globs: params.file.globs } : {}),
      ...(params.triggerFilePath !== undefined
        ? { trigger_file_path: params.triggerFilePath }
        : {}),
      ...(params.file.parent !== undefined ? { parent_file_path: params.file.parent } : {}),
    },
  });
}

function errnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
