/** Environment expansion helpers for MCP server configs. */

export function buildMcpProcessEnv(
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = readProcessEnv();
  if (extra === undefined) return env;
  for (const [key, value] of Object.entries(extra)) {
    env[key] = expandMcpEnvValue(value, env);
  }
  return env;
}

export function buildExpandedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const env = readProcessEnv();
  if (headers === undefined) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, expandMcpEnvValue(value, env)]),
  );
}

export function expandMcpEnvValue(value: string, env: Readonly<Record<string, string>>): string {
  return value.replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (_match, name: string) => env[name] ?? "",
  );
}

function readProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
