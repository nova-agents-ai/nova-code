/** Plugin-provided custom slash command expansion. */

import type { PluginSlashCommand } from "./types.ts";

export interface PluginSlashInvocationResult {
  readonly command: PluginSlashCommand;
  readonly args: string;
  readonly prompt: string;
}

interface ParsedSlashInvocation {
  readonly name: string;
  readonly args: string;
}

export function resolvePluginSlashInvocation(
  input: string,
  commands: readonly PluginSlashCommand[] | undefined,
): PluginSlashInvocationResult | undefined {
  if (commands === undefined || commands.length === 0) return undefined;
  const parsed = parseSlashInvocation(input);
  if (parsed === undefined) return undefined;
  const command = findPluginSlashCommand(commands, parsed.name);
  if (command === undefined) return undefined;
  return {
    command,
    args: parsed.args,
    prompt: formatPluginSlashPrompt(command, parsed.args),
  };
}

export function formatPluginSlashListing(
  commands: readonly PluginSlashCommand[],
): string | undefined {
  if (commands.length === 0) return undefined;
  return commands.map((command) => `/${command.name}  ${command.description}`).join("\n");
}

function parseSlashInvocation(input: string): ParsedSlashInvocation | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return undefined;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  if (rawName === undefined || rawName === "") return undefined;
  return { name: rawName, args: rest.join(" ") };
}

function findPluginSlashCommand(
  commands: readonly PluginSlashCommand[],
  name: string,
): PluginSlashCommand | undefined {
  const normalized = name.toLowerCase();
  return commands.find((command) => command.name.toLowerCase() === normalized);
}

function formatPluginSlashPrompt(command: PluginSlashCommand, args: string): string {
  const argumentBlock = args.trim() === "" ? "(none)" : args;
  return [
    `The user directly invoked the plugin slash command "/${command.name}".`,
    `Plugin: ${command.pluginName}`,
    `Command source: ${command.path}`,
    "",
    "Arguments:",
    argumentBlock,
    "",
    "Command content:",
    formatCommandContent(command, args),
  ].join("\n");
}

function formatCommandContent(command: PluginSlashCommand, args: string): string {
  const content = [`Base directory for this command: ${command.directory}`, "", command.body].join(
    "\n",
  );
  // Always replace the placeholder so the literal "$ARGUMENTS" never reaches the
  // model; without args, expand to empty string.
  return content.replaceAll("$ARGUMENTS", args);
}
