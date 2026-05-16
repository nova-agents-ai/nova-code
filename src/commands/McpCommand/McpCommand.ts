/** `nova-code mcp`：管理 MCP servers and inspect bridged tools. */

import {
  type ConfigSource,
  loadPersistedConfig,
  type PersistedConfig,
  savePersistedConfig,
  validateMcpServerName,
} from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import { createMcpToolRegistryFromServers } from "../../services/mcp/index.ts";
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpStreamableHttpServerConfig,
} from "../../services/mcp/types.ts";
import type { CommandDefinition } from "../types.ts";

interface McpCommandIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunMcpCommandOptions {
  readonly configSource?: ConfigSource;
  readonly io?: McpCommandIO;
}

export const mcpCommand: CommandDefinition = {
  name: "mcp",
  description: "管理 MCP server 配置并查看可用 MCP 工具",
  usage:
    "nova-code mcp list\n" +
    "nova-code mcp add <name> [--auto-approve] [--timeout-ms <ms>] [--cwd <dir>] [--env KEY=VALUE] -- <command> [args...]\n" +
    "nova-code mcp add-http <name> [--auto-approve] [--timeout-ms <ms>] [--header KEY=VALUE] <url>\n" +
    "nova-code mcp remove <name>\n" +
    "nova-code mcp tools",
  run: (args) => runMcpCommand(args),
};

export async function runMcpCommand(
  args: readonly string[],
  options: RunMcpCommandOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO();

  try {
    const action = parseMcpAction(args);
    if (action.ok === false) {
      io.stderr(`mcp: ${action.message}\n`);
      return 1;
    }

    switch (action.kind) {
      case "list":
        return await runList(options, io);
      case "add":
      case "add-http":
        return await runAdd(action, options, io);
      case "remove":
        return await runRemove(action.name, options, io);
      case "tools":
        return await runTools(options, io);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`mcp: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

type ParsedMcpAction =
  | { readonly ok: true; readonly kind: "list" }
  | { readonly ok: true; readonly kind: "tools" }
  | { readonly ok: true; readonly kind: "remove"; readonly name: string }
  | {
      readonly ok: true;
      readonly kind: "add" | "add-http";
      readonly name: string;
      readonly server: McpServerConfig;
    }
  | { readonly ok: false; readonly message: string };

function parseMcpAction(args: readonly string[]): ParsedMcpAction {
  const [kind, ...rest] = args;
  if (kind === undefined || kind === "list") return { ok: true, kind: "list" };
  if (kind === "tools") return parseNoArgs("tools", rest);
  if (kind === "remove") return parseRemove(rest);
  if (kind === "add") return parseAdd(rest);
  if (kind === "add-http") return parseAddHttp(rest);
  return { ok: false, message: "expected list, add, add-http, remove, or tools" };
}

function parseNoArgs(kind: "tools", rest: readonly string[]): ParsedMcpAction {
  if (rest.length > 0) return { ok: false, message: `usage: nova-code mcp ${kind}` };
  return { ok: true, kind };
}

function parseRemove(rest: readonly string[]): ParsedMcpAction {
  const [name, extra] = rest;
  if (name === undefined || extra !== undefined) {
    return { ok: false, message: "usage: nova-code mcp remove <name>" };
  }
  validateMcpServerName(name);
  return { ok: true, kind: "remove", name };
}

function parseAdd(rest: readonly string[]): ParsedMcpAction {
  const [name, ...tokens] = rest;
  if (name === undefined) {
    return { ok: false, message: "usage: nova-code mcp add <name> -- <command>" };
  }
  validateMcpServerName(name);

  const parsed = parseAddOptions(tokens);
  if (parsed.ok === false) return parsed;
  const [command, ...args] = parsed.command;
  if (command === undefined || command.trim() === "") {
    return { ok: false, message: "mcp add requires a command after --" };
  }
  const server: McpStdioServerConfig = {
    type: "stdio",
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(parsed.env).length > 0 ? { env: parsed.env } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.autoApprove ? { autoApprove: true } : {}),
  };
  return { ok: true, kind: "add", name, server };
}

function parseAddHttp(rest: readonly string[]): ParsedMcpAction {
  const [name, ...tokens] = rest;
  if (name === undefined) {
    return { ok: false, message: "usage: nova-code mcp add-http <name> <url>" };
  }
  validateMcpServerName(name);
  const parsed = parseAddHttpOptions(tokens);
  if (parsed.ok === false) return parsed;
  const server: McpStreamableHttpServerConfig = {
    type: "http",
    url: parsed.url,
    ...(Object.keys(parsed.headers).length > 0 ? { headers: parsed.headers } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.autoApprove ? { autoApprove: true } : {}),
  };
  return { ok: true, kind: "add-http", name, server };
}

interface ParsedAddOptions {
  readonly ok: true;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly autoApprove: boolean;
}

type ParsedAddOptionsResult = ParsedAddOptions | { readonly ok: false; readonly message: string };

function parseAddOptions(tokens: readonly string[]): ParsedAddOptionsResult {
  const env: Record<string, string> = {};
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  let autoApprove = false;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "--") {
      return { ok: true, command: tokens.slice(index + 1), env, cwd, timeoutMs, autoApprove };
    }
    if (token === "--auto-approve") {
      autoApprove = true;
      index += 1;
      continue;
    }
    if (token === "--cwd") {
      const value = tokens[index + 1];
      if (value === undefined) return { ok: false, message: "--cwd requires a value" };
      cwd = value;
      index += 2;
      continue;
    }
    if (token === "--timeout-ms") {
      const value = tokens[index + 1];
      const parsed = parsePositiveInteger(value, "--timeout-ms");
      if (parsed.ok === false) return parsed;
      timeoutMs = parsed.value;
      index += 2;
      continue;
    }
    if (token === "--env") {
      const value = tokens[index + 1];
      const parsed = parseEnvPair(value);
      if (parsed.ok === false) return parsed;
      env[parsed.key] = parsed.value;
      index += 2;
      continue;
    }
    return { ok: true, command: tokens.slice(index), env, cwd, timeoutMs, autoApprove };
  }

  return { ok: true, command: [], env, cwd, timeoutMs, autoApprove };
}

interface ParsedAddHttpOptions {
  readonly ok: true;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly autoApprove: boolean;
}

type ParsedAddHttpOptionsResult =
  | ParsedAddHttpOptions
  | { readonly ok: false; readonly message: string };

function parseAddHttpOptions(tokens: readonly string[]): ParsedAddHttpOptionsResult {
  const headers: Record<string, string> = {};
  let timeoutMs: number | undefined;
  let autoApprove = false;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "--auto-approve") {
      autoApprove = true;
      index += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      const value = tokens[index + 1];
      const parsed = parsePositiveInteger(value, "--timeout-ms");
      if (parsed.ok === false) return parsed;
      timeoutMs = parsed.value;
      index += 2;
      continue;
    }
    if (token === "--header") {
      const value = tokens[index + 1];
      const parsed = parseHeaderPair(value);
      if (parsed.ok === false) return parsed;
      headers[parsed.key] = parsed.value;
      index += 2;
      continue;
    }
    const url = token;
    if (tokens[index + 1] !== undefined) return { ok: false, message: "add-http accepts one URL" };
    const validatedUrl = parseHttpUrl(url);
    if (validatedUrl.ok === false) return validatedUrl;
    return { ok: true, url, headers, timeoutMs, autoApprove };
  }

  return { ok: false, message: "mcp add-http requires a URL" };
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: false, message: `${label} requires a value` };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `${label} must be a positive integer` };
  }
  return { ok: true, value: parsed };
}

function parseEnvPair(
  value: string | undefined,
):
  | { readonly ok: true; readonly key: string; readonly value: string }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: false, message: "--env requires KEY=VALUE" };
  const separator = value.indexOf("=");
  if (separator <= 0) return { ok: false, message: "--env requires KEY=VALUE" };
  const key = value.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return { ok: false, message: `invalid env key ${key}` };
  }
  return { ok: true, key, value: value.slice(separator + 1) };
}

function parseHeaderPair(
  value: string | undefined,
):
  | { readonly ok: true; readonly key: string; readonly value: string }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: false, message: "--header requires KEY=VALUE" };
  const separator = value.indexOf("=");
  if (separator <= 0) return { ok: false, message: "--header requires KEY=VALUE" };
  const key = value.slice(0, separator);
  if (!/^[A-Za-z0-9-]+$/.test(key)) return { ok: false, message: `invalid header key ${key}` };
  return { ok: true, key, value: value.slice(separator + 1) };
}

function parseHttpUrl(
  value: string,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return { ok: true };
    return { ok: false, message: "add-http URL must use http or https" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `add-http URL is invalid: ${message}` };
  }
}

async function runList(options: RunMcpCommandOptions, io: McpCommandIO): Promise<number> {
  const config = await loadPersistedConfig(options.configSource);
  const servers = config.mcpServers ?? {};
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    io.stdout("No MCP servers configured.\n");
    return 0;
  }
  for (const [name, server] of entries) {
    const status = server.disabled === true ? "disabled" : "enabled";
    const autoApprove = server.autoApprove === true ? ", autoApprove" : "";
    io.stdout(`${name}\t${status}${autoApprove}\t${formatServerSummary(server)}\n`);
  }
  return 0;
}

async function runAdd(
  action: Extract<ParsedMcpAction, { readonly kind: "add" | "add-http" }>,
  options: RunMcpCommandOptions,
  io: McpCommandIO,
): Promise<number> {
  const current = await loadPersistedConfig(options.configSource);
  const next: PersistedConfig = {
    ...current,
    mcpServers: {
      ...(current.mcpServers ?? {}),
      [action.name]: action.server,
    },
  };
  await savePersistedConfig(next, options.configSource);
  io.stdout(`Added MCP server ${action.name}.\n`);
  return 0;
}

async function runRemove(
  name: string,
  options: RunMcpCommandOptions,
  io: McpCommandIO,
): Promise<number> {
  const current = await loadPersistedConfig(options.configSource);
  const servers = current.mcpServers ?? {};
  if (servers[name] === undefined) {
    io.stderr(`mcp: server ${name} is not configured\n`);
    return 1;
  }
  const remaining = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
  const next: PersistedConfig = { ...current, mcpServers: remaining };
  await savePersistedConfig(next, options.configSource);
  io.stdout(`Removed MCP server ${name}.\n`);
  return 0;
}

async function runTools(options: RunMcpCommandOptions, io: McpCommandIO): Promise<number> {
  const config = await loadPersistedConfig(options.configSource);
  const registry = await createMcpToolRegistryFromServers(config.mcpServers ?? {});
  try {
    for (const warning of registry.warnings) io.stderr(`mcp: ${warning}\n`);
    if (registry.tools.length === 0) {
      io.stdout("No MCP tools available.\n");
      return registry.warnings.length > 0 ? 1 : 0;
    }
    for (const tool of registry.tools) {
      io.stdout(`${tool.name}\t${tool.description.split("\n")[0] ?? ""}\n`);
    }
    return registry.warnings.length > 0 ? 1 : 0;
  } finally {
    await registry.close();
  }
}

function formatServerSummary(server: McpServerConfig): string {
  if (server.type === "http") return `http ${server.url}`;
  const args = server.args?.join(" ") ?? "";
  return `${server.command}${args === "" ? "" : ` ${args}`}`;
}

function defaultIO(): McpCommandIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
