/** Local plugin discovery and contribution loading. */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadPersistedConfig,
  type PluginStateConfig,
  validateMcpServersConfig,
} from "../../config/config.ts";
import { validateHooksConfig } from "../hooks/config.ts";
import type { CommandHook, HooksConfig } from "../hooks/types.ts";
import type { McpServerConfig, McpServersConfig } from "../mcp/types.ts";
import { parseSkillDocument } from "../skills/frontmatter.ts";
import { loadPluginManifest, resolvePluginPath } from "./manifest.ts";
import { mergeHooksConfig, mergeMcpServersConfig } from "./merge.ts";
import type {
  LoadedPlugin,
  LoadPluginCatalogParams,
  PluginCatalog,
  PluginRuleContribution,
  PluginSlashCommand,
  PluginSourceKind,
} from "./types.ts";

const PROJECT_PLUGINS_DIR = ".nova-code/plugins";
const USER_PLUGINS_DIR = ".nova-code/plugins";
const ENV_DISABLE_PLUGINS = "NOVA_DISABLE_PLUGINS";
const ENV_PLUGIN_DIRS = "NOVA_PLUGIN_DIRS";
const DEFAULT_SKILLS_DIR = "skills";
const DEFAULT_COMMANDS_DIR = "commands";
const DEFAULT_RULES_DIR = "rules";
const DEFAULT_CLAUDE_RULES_DIR = ".claude/rules";
const DEFAULT_HOOKS_FILE = "hooks/hooks.json";
const DEFAULT_MCP_FILE = "mcp.json";
const DEFAULT_DOT_MCP_FILE = ".mcp.json";
const PLUGIN_ROOT_BRACED_VARIABLE = "$" + "{NOVA_PLUGIN_ROOT}";
// Unbraced `$NOVA_PLUGIN_ROOT` must not match `$NOVA_PLUGIN_ROOTabc` (would corrupt
// downstream identifiers). Use a manual scan with trailing-char guard rather than a
// naive replaceAll, which would happily clobber the suffix.
const PLUGIN_ROOT_BARE_VARIABLE = "$NOVA_PLUGIN_ROOT";
const PLUGIN_ROOT_BARE_TAIL_PATTERN = /[A-Za-z0-9_]/;

interface PluginRoot {
  readonly path: string;
  readonly sourceKind: PluginSourceKind;
}

interface ContributionLoadResult {
  readonly skillRoots: readonly string[];
  readonly slashCommands: readonly PluginSlashCommand[];
  readonly hooks: HooksConfig;
  readonly mcpServers: McpServersConfig;
  readonly ruleContributions: readonly PluginRuleContribution[];
}

export async function loadPluginCatalog(params: LoadPluginCatalogParams): Promise<PluginCatalog> {
  const env = params.env ?? process.env;
  const roots = resolvePluginRoots(params);
  const warnings: string[] = [];
  const plugins: LoadedPlugin[] = [];
  const seenNames = new Set<string>();
  const stateConfig = (await loadPersistedConfig({ homeDir: params.homeDir })).plugins ?? {};

  if (isTruthy(env[ENV_DISABLE_PLUGINS])) {
    return emptyCatalog(roots);
  }

  for (const root of roots) {
    const pluginDirs = await findPluginDirectories(root.path, warnings);
    for (const pluginDir of pluginDirs) {
      const loaded = await loadPlugin(pluginDir, root.sourceKind, stateConfig, warnings);
      if (loaded.plugin === undefined) {
        warnings.push(`plugin ${pluginDir}: ${loaded.warning}`);
        continue;
      }
      const key = loaded.plugin.name.toLowerCase();
      if (seenNames.has(key)) {
        warnings.push(`duplicate plugin '${loaded.plugin.name}' skipped: ${pluginDir}`);
        continue;
      }
      seenNames.add(key);
      plugins.push(loaded.plugin);
    }
  }

  const contribution = await loadEnabledPluginContributions(plugins, params.cwd, warnings);
  return {
    roots: roots.map((root) => root.path),
    plugins: sortPlugins(plugins),
    warnings,
    ...contribution,
  };
}

export function resolvePluginRoots(params: LoadPluginCatalogParams): readonly PluginRoot[] {
  const env = params.env ?? process.env;
  const home = params.homeDir ?? homedir();
  const configured = env[ENV_PLUGIN_DIRS];
  if (configured !== undefined && configured.trim() !== "") {
    return uniquePluginRoots(
      configured.split(",").map((item) => ({
        path: normalizeRoot(item.trim(), params.cwd, home),
        sourceKind: "configured",
      })),
    );
  }

  return uniquePluginRoots([
    { path: resolve(params.cwd, PROJECT_PLUGINS_DIR), sourceKind: "project" },
    { path: join(home, USER_PLUGINS_DIR), sourceKind: "user" },
  ]);
}

async function loadPlugin(
  pluginDir: string,
  sourceKind: PluginSourceKind,
  stateConfig: Readonly<Record<string, PluginStateConfig>>,
  warnings: string[],
): Promise<
  { readonly plugin: LoadedPlugin } | { readonly warning: string; readonly plugin?: undefined }
> {
  const manifest = await loadPluginManifest(pluginDir);
  if (manifest.ok === false) return { warning: manifest.message };
  const state = stateConfig[manifest.manifest.name];
  const absolutePath = resolve(pluginDir);
  const drift = detectTrustDrift(state, manifest.manifest, absolutePath);
  if (drift !== undefined) {
    warnings.push(
      `plugin ${manifest.manifest.name} trust invalidated (${drift}); rerun 'plugin enable ${manifest.manifest.name} --yes' to re-confirm.`,
    );
  }
  const trusted = state?.trusted === true && drift === undefined;
  const enabled = trusted && state?.enabled === true;
  return {
    plugin: {
      name: manifest.manifest.name,
      path: absolutePath,
      manifestPath: manifest.manifestPath,
      manifest: manifest.manifest,
      sourceKind,
      trusted,
      enabled,
      ...(state !== undefined ? { state } : {}),
    },
  };
}

function detectTrustDrift(
  state: PluginStateConfig | undefined,
  manifest: { readonly version?: string },
  absolutePath: string,
): "path-changed" | "version-changed" | undefined {
  if (state === undefined || state.trusted !== true) return undefined;
  // Path mismatch ⇒ different filesystem location reusing a globally-trusted name.
  if (state.path !== undefined && state.path !== absolutePath) return "path-changed";
  // Version mismatch ⇒ author bumped manifest after trust was granted.
  // We only enforce when both sides declare a version; absent fields stay lenient
  // so legacy state files continue to work.
  if (
    state.version !== undefined &&
    manifest.version !== undefined &&
    state.version !== manifest.version
  ) {
    return "version-changed";
  }
  return undefined;
}

async function loadEnabledPluginContributions(
  plugins: readonly LoadedPlugin[],
  cwd: string,
  warnings: string[],
): Promise<ContributionLoadResult> {
  const skillRoots: string[] = [];
  const slashCommands: PluginSlashCommand[] = [];
  const hookConfigs: HooksConfig[] = [];
  const mcpConfigs: McpServersConfig[] = [];
  const ruleContributions: PluginRuleContribution[] = [];

  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    skillRoots.push(...(await resolveExistingDirectories(getSkillPaths(plugin))));
    slashCommands.push(...(await loadPluginSlashCommands(plugin, warnings)));
    hookConfigs.push(...(await loadPluginHooks(plugin, warnings)));
    mcpConfigs.push(namespaceMcpServers(plugin, await loadPluginMcpServers(plugin, warnings)));
    ruleContributions.push(...(await loadPluginRules(plugin, cwd)));
  }

  return {
    skillRoots,
    slashCommands: sortSlashCommands(slashCommands),
    hooks: mergeHooksConfig(...hookConfigs),
    mcpServers: mergeMcpServersConfig(...mcpConfigs),
    ruleContributions,
  };
}

function getSkillPaths(plugin: LoadedPlugin): readonly string[] {
  return [
    resolve(plugin.path, DEFAULT_SKILLS_DIR),
    ...plugin.manifest.skills.map((path) => resolvePluginPath(plugin.path, path)),
  ];
}

async function loadPluginSlashCommands(
  plugin: LoadedPlugin,
  warnings: string[],
): Promise<readonly PluginSlashCommand[]> {
  const commandPaths = await getExistingCommandPaths(plugin);
  const commands: PluginSlashCommand[] = [];
  for (const commandPath of commandPaths) {
    const files = await findMarkdownFiles(commandPath, warnings);
    for (const file of files) {
      const loaded = await loadPluginSlashCommand(plugin, commandPath, file);
      if (loaded.command === undefined) {
        warnings.push(`plugin ${plugin.name} command ${file}: ${loaded.warning}`);
        continue;
      }
      commands.push(loaded.command);
    }
  }
  return commands;
}

async function getExistingCommandPaths(plugin: LoadedPlugin): Promise<readonly string[]> {
  const paths = [
    resolve(plugin.path, DEFAULT_COMMANDS_DIR),
    ...plugin.manifest.commands.map((path) => resolvePluginPath(plugin.path, path)),
  ];
  return await resolveExistingPaths(paths);
}

async function loadPluginSlashCommand(
  plugin: LoadedPlugin,
  basePath: string,
  filePath: string,
): Promise<
  | { readonly command: PluginSlashCommand }
  | { readonly warning: string; readonly command?: undefined }
> {
  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch (error) {
    return { warning: describeError(error) };
  }
  const document = parseSkillDocument(content);
  const commandName = formatCommandName(plugin.name, basePath, filePath);
  return {
    command: {
      name: commandName,
      pluginName: plugin.name,
      description: readDescription(document.frontmatter, document.body),
      path: filePath,
      directory: dirname(filePath),
      body: document.body,
    },
  };
}

async function loadPluginHooks(
  plugin: LoadedPlugin,
  warnings: string[],
): Promise<readonly HooksConfig[]> {
  const configs: HooksConfig[] = plugin.manifest.inlineHooks.map((config) =>
    substituteHookCommands(config, plugin.path),
  );
  const files = await resolveExistingPaths([
    resolve(plugin.path, DEFAULT_HOOKS_FILE),
    ...plugin.manifest.hookFiles.map((path) => resolvePluginPath(plugin.path, path)),
  ]);
  for (const file of files) {
    const config = await readHooksFile(file, plugin, warnings);
    if (config !== undefined) configs.push(config);
  }
  return configs;
}

async function readHooksFile(
  file: string,
  plugin: LoadedPlugin,
  warnings: string[],
): Promise<HooksConfig | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(file).text()) as unknown;
    const hooks = extractHooksPayload(parsed);
    return substituteHookCommands(validateHooksConfig(hooks, file), plugin.path);
  } catch (error) {
    warnings.push(`plugin ${plugin.name} hooks ${file}: ${describeError(error)}`);
    return undefined;
  }
}

async function loadPluginMcpServers(
  plugin: LoadedPlugin,
  warnings: string[],
): Promise<McpServersConfig> {
  const configs: McpServersConfig[] = plugin.manifest.inlineMcpServers.map((config) =>
    substituteMcpServerConfig(config, plugin.path),
  );
  const files = await resolveExistingPaths([
    resolve(plugin.path, DEFAULT_MCP_FILE),
    resolve(plugin.path, DEFAULT_DOT_MCP_FILE),
    ...plugin.manifest.mcpServerFiles.map((path) => resolvePluginPath(plugin.path, path)),
  ]);
  for (const file of files) {
    const config = await readMcpServersFile(file, plugin, warnings);
    if (config !== undefined) configs.push(config);
  }
  return mergeMcpServersConfig(...configs);
}

async function readMcpServersFile(
  file: string,
  plugin: LoadedPlugin,
  warnings: string[],
): Promise<McpServersConfig | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(file).text()) as unknown;
    const servers = extractMcpServersPayload(parsed);
    return substituteMcpServerConfig(validateMcpServersConfig(servers, file), plugin.path);
  } catch (error) {
    warnings.push(`plugin ${plugin.name} mcpServers ${file}: ${describeError(error)}`);
    return undefined;
  }
}

async function loadPluginRules(
  plugin: LoadedPlugin,
  cwd: string,
): Promise<readonly PluginRuleContribution[]> {
  const paths = await resolveExistingPaths([
    resolve(plugin.path, DEFAULT_RULES_DIR),
    resolve(plugin.path, DEFAULT_CLAUDE_RULES_DIR),
    ...plugin.manifest.rules.map((path) => resolvePluginPath(plugin.path, path)),
  ]);
  return paths.map((rulesPath) => ({ pluginName: plugin.name, rulesPath, baseDir: cwd }));
}

async function findPluginDirectories(root: string, warnings: string[]): Promise<readonly string[]> {
  if (!(await pathExists(root))) return [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    warnings.push(`failed to scan plugin root ${root}: ${describeError(error)}`);
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(root, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function findMarkdownFiles(path: string, warnings: string[]): Promise<readonly string[]> {
  const stats = await safeStat(path);
  if (stats === undefined) return [];
  if (stats.isFile()) return path.endsWith(".md") ? [path] : [];
  if (!stats.isDirectory()) return [];
  return await findMarkdownFilesInDirectory(path, warnings);
}

async function findMarkdownFilesInDirectory(
  dir: string,
  warnings: string[],
): Promise<readonly string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    warnings.push(`failed to scan markdown directory ${dir}: ${describeError(error)}`);
    return [];
  }
  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFilesInDirectory(entryPath, warnings)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

async function resolveExistingDirectories(paths: readonly string[]): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    const stats = await safeStat(path);
    if (stats?.isDirectory() === true) existing.push(path);
  }
  return uniqueStrings(existing);
}

async function resolveExistingPaths(paths: readonly string[]): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    if (await pathExists(path)) existing.push(path);
  }
  return uniqueStrings(existing);
}

function formatCommandName(pluginName: string, basePath: string, filePath: string): string {
  const statsBase = basePath.endsWith(".md") ? dirname(basePath) : basePath;
  const relativePath = relative(statsBase, filePath).split(sep).join("/");
  const withoutExtension = relativePath.replace(/\.md$/i, "");
  const namespace = withoutExtension
    .split("/")
    .map((part) => sanitizeNamePart(part))
    .filter((part) => part !== "")
    .join(":");
  return namespace === "" ? pluginName : `${pluginName}:${namespace}`;
}

function readDescription(frontmatter: Readonly<Record<string, unknown>>, body: string): string {
  const description = frontmatter["description"];
  if (typeof description === "string" && description.trim() !== "") return description.trim();
  const firstLine = body
    .split("\n")
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find((line) => line !== "");
  return firstLine ?? "Plugin slash command";
}

function extractHooksPayload(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "hooks" in value) {
    return (value as Readonly<Record<string, unknown>>)["hooks"];
  }
  return value;
}

function extractMcpServersPayload(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "mcpServers" in value
  ) {
    return (value as Readonly<Record<string, unknown>>)["mcpServers"];
  }
  return value;
}

function substituteHookCommands(config: HooksConfig, pluginPath: string): HooksConfig {
  const result: { -readonly [K in keyof HooksConfig]: NonNullable<HooksConfig[K]> } = {};
  for (const [event, matchers] of Object.entries(config)) {
    const key = event as keyof HooksConfig;
    result[key] = (matchers ?? []).map((matcher) => ({
      ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
      hooks: matcher.hooks.map((hook) => substituteCommandHook(hook, pluginPath)),
    }));
  }
  return result;
}

function substituteCommandHook(hook: CommandHook, pluginPath: string): CommandHook {
  return {
    ...hook,
    command: substitutePluginRoot(hook.command, pluginPath),
    ...(hook.statusMessage !== undefined
      ? { statusMessage: substitutePluginRoot(hook.statusMessage, pluginPath) }
      : {}),
  };
}

function substituteMcpServerConfig(config: McpServersConfig, pluginPath: string): McpServersConfig {
  return Object.fromEntries(
    Object.entries(config).map(([name, server]) => [name, substituteMcpServer(server, pluginPath)]),
  );
}

function substituteMcpServer(server: McpServerConfig, pluginPath: string): McpServerConfig {
  if (server.type === "http") {
    return {
      ...server,
      url: substitutePluginRoot(server.url, pluginPath),
      ...(server.headers !== undefined
        ? { headers: substituteStringRecord(server.headers, pluginPath) }
        : {}),
    };
  }
  return {
    ...server,
    command: substitutePluginRoot(server.command, pluginPath),
    ...(server.args !== undefined
      ? { args: server.args.map((arg) => substitutePluginRoot(arg, pluginPath)) }
      : {}),
    ...(server.env !== undefined ? { env: substituteStringRecord(server.env, pluginPath) } : {}),
    cwd: substitutePluginRoot(server.cwd ?? pluginPath, pluginPath),
  };
}

function namespaceMcpServers(plugin: LoadedPlugin, servers: McpServersConfig): McpServersConfig {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      `${sanitizeNamePart(plugin.name)}_${sanitizeNamePart(name)}`,
      server,
    ]),
  );
}

function substituteStringRecord(
  record: Readonly<Record<string, string>>,
  pluginPath: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, substitutePluginRoot(value, pluginPath)]),
  );
}

function substitutePluginRoot(value: string, pluginPath: string): string {
  const braced = value.replaceAll(PLUGIN_ROOT_BRACED_VARIABLE, pluginPath);
  return replaceBareVariable(braced, pluginPath);
}

function replaceBareVariable(value: string, pluginPath: string): string {
  const variable = PLUGIN_ROOT_BARE_VARIABLE;
  let result = "";
  let index = 0;
  while (index < value.length) {
    const found = value.indexOf(variable, index);
    if (found === -1) {
      result += value.slice(index);
      break;
    }
    const tailIndex = found + variable.length;
    const tail = value[tailIndex];
    result += value.slice(index, found);
    if (tail !== undefined && PLUGIN_ROOT_BARE_TAIL_PATTERN.test(tail)) {
      // Adjacent identifier char (e.g. `$NOVA_PLUGIN_ROOTabc`) — leave the literal
      // alone so we don't silently corrupt the surrounding token.
      result += variable;
    } else {
      result += pluginPath;
    }
    index = tailIndex;
  }
  return result;
}

function uniquePluginRoots(roots: readonly PluginRoot[]): readonly PluginRoot[] {
  const seen = new Set<string>();
  const unique: PluginRoot[] = [];
  for (const root of roots) {
    if (root.path === "" || seen.has(root.path)) continue;
    seen.add(root.path);
    unique.push(root);
  }
  return unique;
}

function normalizeRoot(value: string, cwd: string, home: string): string {
  if (value === "") return "";
  const expanded = value === "~" ? home : value.replace(/^~\//, `${home}/`);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

async function pathExists(path: string): Promise<boolean> {
  return (await safeStat(path)) !== undefined;
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function sortPlugins(plugins: readonly LoadedPlugin[]): readonly LoadedPlugin[] {
  return [...plugins].sort((a, b) => a.name.localeCompare(b.name));
}

function sortSlashCommands(commands: readonly PluginSlashCommand[]): readonly PluginSlashCommand[] {
  return [...commands].sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized === "" ? "unknown" : sanitized;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function emptyCatalog(roots: readonly PluginRoot[]): PluginCatalog {
  return {
    roots: roots.map((root) => root.path),
    plugins: [],
    warnings: [],
    skillRoots: [],
    slashCommands: [],
    hooks: {},
    mcpServers: {},
    ruleContributions: [],
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
