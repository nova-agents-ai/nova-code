/** `nova-code config get|set`：读写 ~/.nova-code/config.json 的轻量 CLI。 */

import type { ConfigSource, PersistedConfig } from "../../config/config.ts";
import { loadPersistedConfig, savePersistedConfig } from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import type { CommandDefinition } from "../types.ts";

interface ConfigCommandIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunConfigCommandOptions {
  readonly configSource?: ConfigSource;
  readonly io?: ConfigCommandIO;
}

const CONFIG_KEYS = ["apiKey", "baseURL", "model", "maxTokens", "maxTurns"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

export const configCommand: CommandDefinition = {
  name: "config",
  description: "读取或更新 ~/.nova-code/config.json",
  usage:
    "nova-code config get [apiKey|baseURL|model|maxTokens|maxTurns]\n" +
    "nova-code config set <apiKey|baseURL|model|maxTokens|maxTurns> <value>",
  run: (args) => runConfigCommand(args),
};

/** 测试友好的 config 命令入口。 */
export async function runConfigCommand(
  args: readonly string[],
  options: RunConfigCommandOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO();
  const action = parseAction(args);
  if (action.ok === false) {
    io.stderr(`config: ${action.message}\n`);
    return 1;
  }

  try {
    if (action.kind === "get") {
      return await runGet(action.key, options, io);
    }
    return await runSet(action.key, action.value, options, io);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`config: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

type ParsedAction =
  | { readonly ok: true; readonly kind: "get"; readonly key?: ConfigKey }
  | { readonly ok: true; readonly kind: "set"; readonly key: ConfigKey; readonly value: string }
  | { readonly ok: false; readonly message: string };

function parseAction(args: readonly string[]): ParsedAction {
  const [kind, keyRaw, value, ...rest] = args;
  if (kind === "get") return parseGetArgs(keyRaw, value, rest);
  if (kind === "set") return parseSetArgs(keyRaw, value, rest);
  return { ok: false, message: "expected `get` or `set`" };
}

function parseGetArgs(
  keyRaw: string | undefined,
  extra: string | undefined,
  rest: readonly string[],
): ParsedAction {
  if (extra !== undefined || rest.length > 0) {
    return { ok: false, message: "usage: nova-code config get [key]" };
  }
  if (keyRaw === undefined) return { ok: true, kind: "get" };
  const key = parseConfigKey(keyRaw);
  if (key === undefined) return { ok: false, message: `unknown key ${keyRaw}` };
  return { ok: true, kind: "get", key };
}

function parseSetArgs(
  keyRaw: string | undefined,
  value: string | undefined,
  rest: readonly string[],
): ParsedAction {
  if (keyRaw === undefined || value === undefined || rest.length > 0) {
    return { ok: false, message: "usage: nova-code config set <key> <value>" };
  }
  const key = parseConfigKey(keyRaw);
  if (key === undefined) return { ok: false, message: `unknown key ${keyRaw}` };
  return { ok: true, kind: "set", key, value };
}

async function runGet(
  key: ConfigKey | undefined,
  options: RunConfigCommandOptions,
  io: ConfigCommandIO,
): Promise<number> {
  const config = await loadPersistedConfig(options.configSource);
  if (key === undefined) {
    io.stdout(`${JSON.stringify(maskConfig(config), null, 2)}\n`);
    return 0;
  }
  io.stdout(`${formatConfigValue(key, config[key])}\n`);
  return 0;
}

async function runSet(
  key: ConfigKey,
  value: string,
  options: RunConfigCommandOptions,
  io: ConfigCommandIO,
): Promise<number> {
  const current = await loadPersistedConfig(options.configSource);
  const next = withConfigValue(current, key, value);
  await savePersistedConfig(next, options.configSource);
  io.stdout(`Set ${key} = ${formatConfigValue(key, next[key])}\n`);
  return 0;
}

function withConfigValue(config: PersistedConfig, key: ConfigKey, value: string): PersistedConfig {
  const parsed = parseConfigValue(key, value);
  switch (key) {
    case "apiKey":
      return { ...config, apiKey: String(parsed) };
    case "baseURL":
      return { ...config, baseURL: String(parsed) };
    case "model":
      return { ...config, model: String(parsed) };
    case "maxTokens":
      return { ...config, maxTokens: Number(parsed) };
    case "maxTurns":
      return { ...config, maxTurns: Number(parsed) };
  }
}

function parseConfigKey(value: string): ConfigKey | undefined {
  return CONFIG_KEYS.find((key) => key === value);
}

function parseConfigValue(key: ConfigKey, value: string): string | number {
  if (key === "maxTokens" || key === "maxTurns") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ConfigError(`${key} must be a positive integer.`);
    }
    return parsed;
  }
  if (value.trim() === "") {
    throw new ConfigError(`${key} must not be empty.`);
  }
  return value;
}

function formatConfigValue(key: ConfigKey, value: string | number | undefined): string {
  if (value === undefined) return "<unset>";
  if (key === "apiKey") return maskSecret(String(value));
  return String(value);
}

function maskConfig(config: PersistedConfig): PersistedConfig {
  return {
    ...config,
    ...(config.apiKey !== undefined ? { apiKey: maskSecret(config.apiKey) } : {}),
  };
}

function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function defaultIO(): ConfigCommandIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
