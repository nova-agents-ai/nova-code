/** M13 local plugin system domain types. */

import type { PluginStateConfig } from "../../config/config.ts";
import type { HooksConfig } from "../hooks/types.ts";
import type { McpServersConfig } from "../mcp/types.ts";

export type PluginEnvironment = Readonly<Record<string, string | undefined>>;

export type PluginSourceKind = "project" | "user" | "configured";

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly skills: readonly string[];
  readonly commands: readonly string[];
  readonly rules: readonly string[];
  readonly hookFiles: readonly string[];
  readonly inlineHooks: readonly HooksConfig[];
  readonly mcpServerFiles: readonly string[];
  readonly inlineMcpServers: readonly McpServersConfig[];
}

export interface LoadedPlugin {
  readonly name: string;
  readonly path: string;
  readonly manifestPath: string;
  readonly manifest: PluginManifest;
  readonly sourceKind: PluginSourceKind;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly state?: PluginStateConfig;
}

export interface PluginSlashCommand {
  readonly name: string;
  readonly pluginName: string;
  readonly description: string;
  readonly path: string;
  readonly directory: string;
  readonly body: string;
}

export interface PluginRuleContribution {
  readonly pluginName: string;
  readonly rulesPath: string;
  readonly baseDir: string;
}

export interface PluginCatalog {
  readonly plugins: readonly LoadedPlugin[];
  readonly roots: readonly string[];
  readonly warnings: readonly string[];
  readonly skillRoots: readonly string[];
  readonly slashCommands: readonly PluginSlashCommand[];
  readonly hooks: HooksConfig;
  readonly mcpServers: McpServersConfig;
  readonly ruleContributions: readonly PluginRuleContribution[];
}

export interface LoadPluginCatalogParams {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly env?: PluginEnvironment;
}
