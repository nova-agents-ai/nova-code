/** Hook matcher and optional `if` condition evaluation. */

import { type CommandHook, HookEventName, type HookInput, type HooksConfig } from "./types.ts";

/** Return all command hooks that match the event input, preserving config order and de-duping commands. */
export function getMatchingCommandHooks(
  config: HooksConfig | undefined,
  event: HookEventName,
  input: HookInput,
): readonly CommandHook[] {
  const matchers = config?.[event] ?? [];
  const query = getMatchQuery(input);
  const matched: CommandHook[] = [];
  const seen = new Set<string>();

  for (const matcher of matchers) {
    if (!matchesPattern(query, matcher.matcher)) continue;
    for (const hook of matcher.hooks) {
      if (!matchesIfCondition(hook.if, input)) continue;
      const key = `${hook.command}\0${hook.if ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(hook);
    }
  }
  return matched;
}

function getMatchQuery(input: HookInput): string {
  switch (input.hook_event_name) {
    case HookEventName.PRE_TOOL_USE:
    case HookEventName.POST_TOOL_USE:
      return input.tool_name;
  }
}

function matchesPattern(query: string, matcher: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_|:-]+$/.test(matcher)) {
    return matcher.split("|").some((part) => part.trim() === query);
  }
  try {
    return new RegExp(matcher).test(query);
  } catch {
    return false;
  }
}

function matchesIfCondition(condition: string | undefined, input: HookInput): boolean {
  if (condition === undefined || condition.trim() === "") return true;
  const parsed = parseIfCondition(condition);
  if (parsed === undefined) return false;
  if (parsed.toolName !== input.tool_name) return false;
  if (parsed.pattern === undefined || parsed.pattern.trim() === "") return true;
  return wildcardMatches(getToolComparableValue(input.tool_input), parsed.pattern);
}

function parseIfCondition(
  condition: string,
): { readonly toolName: string; readonly pattern?: string } | undefined {
  const match = /^([A-Za-z0-9_:-]+)(?:\((.*)\))?$/.exec(condition.trim());
  const toolName = match?.[1];
  if (toolName === undefined) return undefined;
  return { toolName, ...(match?.[2] !== undefined ? { pattern: match[2] } : {}) };
}

function getToolComparableValue(input: Readonly<Record<string, unknown>>): string {
  const command = getStringProperty(input, "command");
  if (command !== undefined) return command;
  const path =
    getStringProperty(input, "path") ??
    getStringProperty(input, "file_path") ??
    getStringProperty(input, "url") ??
    getStringProperty(input, "query");
  if (path !== undefined) return path;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

function getStringProperty(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function wildcardMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
