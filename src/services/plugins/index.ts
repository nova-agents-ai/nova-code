export { loadPluginCatalog, resolvePluginRoots } from "./loader.ts";
export { loadPluginManifest, resolvePluginPath, validatePluginManifest } from "./manifest.ts";
export { mergeHooksConfig, mergeMcpServersConfig } from "./merge.ts";
export {
  formatPluginSlashListing,
  type PluginSlashInvocationResult,
  resolvePluginSlashInvocation,
} from "./slash.ts";
export type {
  LoadedPlugin,
  LoadPluginCatalogParams,
  PluginCatalog,
  PluginEnvironment,
  PluginManifest,
  PluginRuleContribution,
  PluginSlashCommand,
  PluginSourceKind,
} from "./types.ts";
