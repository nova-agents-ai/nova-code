/** Plugin manifest loading and runtime validation. */

import { resolve } from "node:path";
import { validateMcpServersConfig } from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import { validateHooksConfig } from "../hooks/config.ts";
import type { HooksConfig } from "../hooks/types.ts";
import type { McpServersConfig } from "../mcp/types.ts";
import type { PluginManifest } from "./types.ts";

const ROOT_MANIFEST_NAME = "plugin.json";
const NESTED_MANIFEST_PATH = ".nova-code-plugin/plugin.json";
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type PluginManifestLoadResult =
  | { readonly ok: true; readonly manifest: PluginManifest; readonly manifestPath: string }
  | { readonly ok: false; readonly message: string };

export async function loadPluginManifest(pluginDir: string): Promise<PluginManifestLoadResult> {
  const manifestPath = await resolveManifestPath(pluginDir);
  if (manifestPath === undefined) {
    return { ok: false, message: `missing ${ROOT_MANIFEST_NAME}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(manifestPath).text());
  } catch (error) {
    return { ok: false, message: `failed to parse ${manifestPath}: ${describeError(error)}` };
  }

  try {
    return {
      ok: true,
      manifest: validatePluginManifest(parsed, manifestPath),
      manifestPath,
    };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export function validatePluginManifest(value: unknown, path: string): PluginManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Plugin manifest at ${path} must be a JSON object.`);
  }
  const obj = value as Readonly<Record<string, unknown>>;
  const name = validatePluginName(obj["name"], `${path}.name`);
  return {
    name,
    skills: validatePathList(obj["skills"], `${path}.skills`),
    commands: validatePathList(obj["commands"], `${path}.commands`),
    rules: validatePathList(obj["rules"], `${path}.rules`),
    hookFiles: validateContributionFiles(obj["hooks"], `${path}.hooks`, isJsonPath),
    inlineHooks: validateInlineHooks(obj["hooks"], `${path}.hooks`),
    mcpServerFiles: validateContributionFiles(obj["mcpServers"], `${path}.mcpServers`, isJsonPath),
    inlineMcpServers: validateInlineMcpServers(obj["mcpServers"], `${path}.mcpServers`),
    ...(readOptionalString(obj["version"], `${path}.version`) !== undefined
      ? { version: readOptionalString(obj["version"], `${path}.version`) }
      : {}),
    ...(readOptionalString(obj["description"], `${path}.description`) !== undefined
      ? { description: readOptionalString(obj["description"], `${path}.description`) }
      : {}),
  };
}

export async function resolveManifestPath(pluginDir: string): Promise<string | undefined> {
  const rootManifest = resolve(pluginDir, ROOT_MANIFEST_NAME);
  if (await Bun.file(rootManifest).exists()) return rootManifest;
  const nestedManifest = resolve(pluginDir, NESTED_MANIFEST_PATH);
  if (await Bun.file(nestedManifest).exists()) return nestedManifest;
  return undefined;
}

export function resolvePluginPath(pluginDir: string, relativePath: string): string {
  const normalized = relativePath.trim();
  const withoutDot = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  return resolve(pluginDir, withoutDot);
}

function validatePluginName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (!PLUGIN_NAME_PATTERN.test(normalized)) {
    throw new ConfigError(`${field} must match ${PLUGIN_NAME_PATTERN}.`);
  }
  return normalized;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function validatePathList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [validateRelativePath(value, field)];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a relative path or an array of relative paths.`);
  }
  return value.map((item, index) => validateRelativePath(item, `${field}[${index}]`));
}

function validateContributionFiles(
  value: unknown,
  field: string,
  acceptsPath: (path: string) => boolean,
): readonly string[] {
  if (value === undefined || isPlainObjectContribution(value)) return [];
  if (typeof value === "string") return [validateContributionPath(value, field, acceptsPath)];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a path, object, or an array of paths/objects.`);
  }
  const files: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemField = `${field}[${index}]`;
    if (isPlainObjectContribution(item)) continue;
    if (typeof item !== "string") {
      throw new ConfigError(`${itemField} must be a path or object, got ${typeName(item)}.`);
    }
    files.push(validateContributionPath(item, itemField, acceptsPath));
  }
  return files;
}

function validateInlineHooks(value: unknown, field: string): readonly HooksConfig[] {
  if (value === undefined) return [];
  if (isPlainObjectContribution(value)) return [validateHooksConfig(value, field)];
  if (typeof value === "string") return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${field} must be a path, hooks object, or an array of paths/objects, got ${typeName(value)}.`,
    );
  }
  const configs: HooksConfig[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemField = `${field}[${index}]`;
    if (isPlainObjectContribution(item)) {
      configs.push(validateHooksConfig(item, itemField));
      continue;
    }
    if (typeof item !== "string") {
      throw new ConfigError(`${itemField} must be a path or object, got ${typeName(item)}.`);
    }
  }
  return configs;
}

function validateInlineMcpServers(value: unknown, field: string): readonly McpServersConfig[] {
  if (value === undefined) return [];
  if (isPlainObjectContribution(value)) return [validateMcpServersConfig(value, field)];
  if (typeof value === "string") return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${field} must be a path, mcpServers object, or an array of paths/objects, got ${typeName(value)}.`,
    );
  }
  const configs: McpServersConfig[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemField = `${field}[${index}]`;
    if (isPlainObjectContribution(item)) {
      configs.push(validateMcpServersConfig(item, itemField));
      continue;
    }
    if (typeof item !== "string") {
      throw new ConfigError(`${itemField} must be a path or object, got ${typeName(item)}.`);
    }
  }
  return configs;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateContributionPath(
  value: unknown,
  field: string,
  acceptsPath: (path: string) => boolean,
): string {
  const path = validateRelativePath(value, field);
  if (!acceptsPath(path)) throw new ConfigError(`${field} must point to a .json file.`);
  return path;
}

function validateRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty relative path.`);
  }
  const normalized = value.trim();
  if (normalized.startsWith("/")) {
    throw new ConfigError(`${field} must stay inside the plugin directory.`);
  }
  // Reject `..` only when it's a full path segment — otherwise valid filenames
  // like `foo..bar.md` would be over-rejected.
  const segments = normalized.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new ConfigError(`${field} must stay inside the plugin directory.`);
  }
  return normalized;
}

function isJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith(".json");
}

function isPlainObjectContribution(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
