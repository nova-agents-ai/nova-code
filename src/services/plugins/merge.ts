/** Plugin contribution merge helpers. */

import type { HooksConfig } from "../hooks/types.ts";
import type { McpServersConfig } from "../mcp/types.ts";

export function mergeHooksConfig(...configs: readonly (HooksConfig | undefined)[]): HooksConfig {
  const merged: { -readonly [K in keyof HooksConfig]: NonNullable<HooksConfig[K]> } = {};
  for (const config of configs) {
    if (config === undefined) continue;
    for (const [eventName, matchers] of Object.entries(config)) {
      if (matchers === undefined) continue;
      const key = eventName as keyof HooksConfig;
      merged[key] = [...(merged[key] ?? []), ...matchers];
    }
  }
  return merged;
}

export function mergeMcpServersConfig(
  ...configs: readonly (McpServersConfig | undefined)[]
): McpServersConfig {
  const merged: Record<string, McpServersConfig[string]> = {};
  for (const config of configs) {
    if (config === undefined) continue;
    for (const [name, server] of Object.entries(config)) {
      if (merged[name] !== undefined) continue;
      merged[name] = server;
    }
  }
  return merged;
}
