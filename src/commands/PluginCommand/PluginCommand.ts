/** `nova-code plugin`：管理 M13 local plugins. */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ConfigSource,
  loadPersistedConfig,
  type PersistedConfig,
  type PluginStateConfig,
  savePersistedConfig,
} from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import {
  type LoadedPlugin,
  loadPluginCatalog,
  loadPluginManifest,
  type PluginEnvironment,
  type PluginManifest,
} from "../../services/plugins/index.ts";
import type { CommandDefinition } from "../types.ts";

interface PluginCommandIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunPluginCommandOptions {
  readonly cwd?: string;
  readonly configSource?: ConfigSource;
  readonly env?: PluginEnvironment;
  readonly io?: PluginCommandIO;
  readonly now?: () => Date;
}

export const pluginCommand: CommandDefinition = {
  name: "plugin",
  description: "发现、启用、禁用、验证本地插件",
  usage:
    "nova-code plugin list\n" +
    "nova-code plugin enable <name> --yes\n" +
    "nova-code plugin disable <name>\n" +
    "nova-code plugin reload\n" +
    "nova-code plugin validate [name|path]",
  run: (args) => runPluginCommand(args),
};

export async function runPluginCommand(
  args: readonly string[],
  options: RunPluginCommandOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO();
  const action = parseAction(args);
  if (action.ok === false) {
    io.stderr(`plugin: ${action.message}\n`);
    return 1;
  }

  try {
    switch (action.kind) {
      case "list":
        return await runList(options, io);
      case "enable":
        return await runEnable(action.name, action.yes, options, io);
      case "disable":
        return await runDisable(action.name, options, io);
      case "reload":
        return await runReload(options, io);
      case "validate":
        return await runValidate(action.target, options, io);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`plugin: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

type ParsedAction =
  | { readonly ok: true; readonly kind: "list" }
  | { readonly ok: true; readonly kind: "reload" }
  | { readonly ok: true; readonly kind: "validate"; readonly target?: string }
  | { readonly ok: true; readonly kind: "enable"; readonly name: string; readonly yes: boolean }
  | { readonly ok: true; readonly kind: "disable"; readonly name: string }
  | { readonly ok: false; readonly message: string };

function parseAction(args: readonly string[]): ParsedAction {
  const [kind, ...rest] = args;
  if (kind === undefined || kind === "list") return parseNoArgs("list", rest);
  if (kind === "reload") return parseNoArgs("reload", rest);
  if (kind === "validate") return parseValidate(rest);
  if (kind === "enable") return parseEnable(rest);
  if (kind === "disable") return parseDisable(rest);
  return { ok: false, message: "expected list, enable, disable, reload, or validate" };
}

function parseNoArgs(kind: "list" | "reload", rest: readonly string[]): ParsedAction {
  if (rest.length > 0) return { ok: false, message: `usage: nova-code plugin ${kind}` };
  return { ok: true, kind };
}

function parseValidate(rest: readonly string[]): ParsedAction {
  const [target, extra] = rest;
  if (extra !== undefined)
    return { ok: false, message: "usage: nova-code plugin validate [name|path]" };
  return target === undefined
    ? { ok: true, kind: "validate" }
    : { ok: true, kind: "validate", target };
}

function parseEnable(rest: readonly string[]): ParsedAction {
  const [name, ...flags] = rest;
  if (name === undefined || name === "") {
    return { ok: false, message: "usage: nova-code plugin enable <name> --yes" };
  }
  const yes = flags.includes("--yes");
  const unknown = flags.find((flag) => flag !== "--yes");
  if (unknown !== undefined) return { ok: false, message: `unknown flag ${unknown}` };
  return { ok: true, kind: "enable", name, yes };
}

function parseDisable(rest: readonly string[]): ParsedAction {
  const [name, extra] = rest;
  if (name === undefined || extra !== undefined) {
    return { ok: false, message: "usage: nova-code plugin disable <name>" };
  }
  return { ok: true, kind: "disable", name };
}

async function runList(options: RunPluginCommandOptions, io: PluginCommandIO): Promise<number> {
  const catalog = await loadCatalog(options);
  printWarnings(catalog.warnings, io);
  if (catalog.plugins.length === 0) {
    io.stdout("No plugins found.\n");
    return catalog.warnings.length > 0 ? 1 : 0;
  }
  for (const plugin of catalog.plugins) {
    io.stdout(formatPluginListItem(plugin));
  }
  return catalog.warnings.length > 0 ? 1 : 0;
}

async function runEnable(
  name: string,
  yes: boolean,
  options: RunPluginCommandOptions,
  io: PluginCommandIO,
): Promise<number> {
  const plugin = await findPluginOrReport(name, options, io);
  if (plugin === undefined) return 1;
  if (!plugin.trusted && !yes) {
    io.stderr(
      `plugin: ${name} is untrusted. Review ${plugin.manifestPath} and rerun with --yes to trust and enable it.\n`,
    );
    return 1;
  }
  const enabledAt = (options.now ?? (() => new Date()))().toISOString();
  await updatePluginState(plugin.name, options, {
    enabled: true,
    trusted: true,
    path: plugin.path,
    lastReloadedAt: enabledAt,
    ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
  });
  io.stdout(`Enabled plugin ${plugin.name}.\n`);
  return 0;
}

async function runDisable(
  name: string,
  options: RunPluginCommandOptions,
  io: PluginCommandIO,
): Promise<number> {
  const plugin = await findPluginOrReport(name, options, io);
  if (plugin === undefined) return 1;
  await updatePluginState(plugin.name, options, { enabled: false });
  io.stdout(`Disabled plugin ${plugin.name}.\n`);
  return 0;
}

async function runReload(options: RunPluginCommandOptions, io: PluginCommandIO): Promise<number> {
  const catalog = await loadCatalog(options);
  printWarnings(catalog.warnings, io);
  const enabledPlugins = catalog.plugins.filter((plugin) => plugin.enabled);
  const reloadedAt = (options.now ?? (() => new Date()))().toISOString();
  for (const plugin of enabledPlugins) {
    await updatePluginState(plugin.name, options, { lastReloadedAt: reloadedAt });
  }
  io.stdout(`Reloaded ${enabledPlugins.length} enabled plugin(s).\n`);
  return catalog.warnings.length > 0 ? 1 : 0;
}

async function runValidate(
  target: string | undefined,
  options: RunPluginCommandOptions,
  io: PluginCommandIO,
): Promise<number> {
  if (target !== undefined && (await pathExists(resolve(options.cwd ?? process.cwd(), target)))) {
    return await validatePluginPath(resolve(options.cwd ?? process.cwd(), target), io);
  }
  const catalog = await loadCatalog(options);
  printWarnings(catalog.warnings, io);
  const targets =
    target === undefined ? catalog.plugins : catalog.plugins.filter(matchesName(target));
  if (targets.length === 0) {
    io.stderr(
      target === undefined ? "plugin: no plugins found\n" : `plugin: not found: ${target}\n`,
    );
    return 1;
  }
  for (const plugin of targets) io.stdout(formatValidationSuccess(plugin.manifest, plugin.path));
  return catalog.warnings.length > 0 ? 1 : 0;
}

async function validatePluginPath(path: string, io: PluginCommandIO): Promise<number> {
  const load = await loadPluginManifest(path);
  if (load.ok === false) {
    io.stderr(`plugin: ${path}: ${load.message}\n`);
    return 1;
  }
  io.stdout(formatValidationSuccess(load.manifest, path));
  return 0;
}

async function findPluginOrReport(
  name: string,
  options: RunPluginCommandOptions,
  io: PluginCommandIO,
): Promise<LoadedPlugin | undefined> {
  const catalog = await loadCatalog(options);
  printWarnings(catalog.warnings, io);
  const plugin = catalog.plugins.find(matchesName(name));
  if (plugin !== undefined) return plugin;
  io.stderr(`plugin: not found: ${name}\n`);
  return undefined;
}

async function loadCatalog(options: RunPluginCommandOptions) {
  return await loadPluginCatalog({
    cwd: options.cwd ?? process.cwd(),
    ...(options.configSource?.homeDir !== undefined
      ? { homeDir: options.configSource.homeDir }
      : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
}

async function updatePluginState(
  name: string,
  options: RunPluginCommandOptions,
  patch: Partial<PluginStateConfig>,
): Promise<void> {
  const current = await loadPersistedConfig(options.configSource);
  const previous = current.plugins?.[name] ?? {};
  const next: PersistedConfig = {
    ...current,
    plugins: {
      ...(current.plugins ?? {}),
      [name]: { ...previous, ...patch },
    },
  };
  await savePersistedConfig(next, options.configSource);
}

function formatPluginListItem(plugin: LoadedPlugin): string {
  const version = plugin.manifest.version ?? "<no-version>";
  const description = plugin.manifest.description ?? "";
  return `${plugin.name}\t${formatStatus(plugin)}\t${version}\t${description}\t${plugin.path}\n`;
}

function formatStatus(plugin: LoadedPlugin): string {
  if (!plugin.trusted) return "untrusted";
  return plugin.enabled ? "enabled" : "disabled";
}

function formatValidationSuccess(manifest: PluginManifest, pluginPath: string): string {
  const version = manifest.version === undefined ? "" : ` v${manifest.version}`;
  return `Valid plugin ${manifest.name}${version} at ${pluginPath}\n`;
}

function matchesName(name: string): (plugin: LoadedPlugin) => boolean {
  const normalized = name.toLowerCase();
  return (plugin) => plugin.name.toLowerCase() === normalized;
}

function printWarnings(warnings: readonly string[], io: PluginCommandIO): void {
  for (const warning of warnings) io.stderr(`[plugin] ${warning}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function defaultIO(): PluginCommandIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
