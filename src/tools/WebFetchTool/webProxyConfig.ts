/** Web proxy routing config shared by WebFetch and WebSearch. */

import { loadPersistedConfig, type PersistedConfig } from "../../config/config.ts";
import { ConfigError, ToolExecutionError } from "../../errors/index.ts";

const ENV_WEB_PROXY = "NOVA_WEB_PROXY";
const ENV_WEB_PROXY_DOMAINS = "NOVA_WEB_PROXY_DOMAINS";

export interface WebProxyConfig {
  readonly proxyUrl: string | undefined;
  readonly proxyDomains: readonly string[];
}

export type WebProxyDecisionSource = "domain" | "llm";

export interface WebProxyDecision {
  readonly proxyUrl: string | undefined;
  readonly source: WebProxyDecisionSource | undefined;
  readonly matchedDomain: string | undefined;
}

export interface WebProxyLoadSource {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function loadWebProxyConfig(source: WebProxyLoadSource = {}): Promise<WebProxyConfig> {
  const persisted = await loadPersistedConfig();
  return resolveWebProxyConfig({ persisted, env: source.env ?? process.env });
}

export function resolveWebProxyConfig(params: {
  readonly persisted: PersistedConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
}): WebProxyConfig {
  const proxyUrl = normalizeProxyUrl(params.env[ENV_WEB_PROXY] ?? params.persisted.webProxy);
  const proxyDomains = normalizeProxyDomains(
    params.env[ENV_WEB_PROXY_DOMAINS] !== undefined
      ? parseProxyDomains(params.env[ENV_WEB_PROXY_DOMAINS])
      : (params.persisted.webProxyDomains ?? []),
  );
  return { proxyUrl, proxyDomains };
}

export async function decideWebProxy(params: {
  readonly url: URL;
  readonly forceProxy: boolean;
  readonly toolName: string;
}): Promise<WebProxyDecision> {
  return decideWebProxyFromConfig({
    url: params.url,
    forceProxy: params.forceProxy,
    toolName: params.toolName,
    config: await loadWebProxyConfig(),
  });
}

export function decideWebProxyFromConfig(params: {
  readonly url: URL;
  readonly forceProxy: boolean;
  readonly toolName: string;
  readonly config: WebProxyConfig;
}): WebProxyDecision {
  const matchedDomain = matchProxyDomain(
    normalizeHostname(params.url.hostname),
    params.config.proxyDomains,
  );
  const shouldUseProxy = params.forceProxy || matchedDomain !== undefined;
  if (!shouldUseProxy) {
    return { proxyUrl: undefined, source: undefined, matchedDomain: undefined };
  }
  if (params.config.proxyUrl === undefined) {
    throw new ToolExecutionError(
      params.toolName,
      "Web proxy was requested or matched by domain rules, but no webProxy is configured. " +
        "Set NOVA_WEB_PROXY or `nova-code config set webProxy <url>`.",
    );
  }
  return {
    proxyUrl: params.config.proxyUrl,
    source: params.forceProxy ? "llm" : "domain",
    matchedDomain,
  };
}

export function formatProxyDecision(
  decision: Pick<WebProxyDecision, "source" | "matchedDomain">,
): string {
  if (decision.source === undefined) return "";
  if (decision.source === "llm") return "Proxy: used (requested by tool input)";
  if (decision.matchedDomain !== undefined) {
    return `Proxy: used (matched domain: ${decision.matchedDomain})`;
  }
  return "Proxy: used";
}

export function normalizeProxyUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigError(`webProxy must be a valid URL: ${describeError(error)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`webProxy must use http or https, got ${url.protocol}.`);
  }
  return value;
}

function parseProxyDomains(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function normalizeProxyDomains(values: readonly string[]): readonly string[] {
  return values.map(normalizeProxyDomain).filter((value) => value !== "");
}

function normalizeProxyDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "*") return "*";
  const maybeUrl = parseMaybeUrl(trimmed);
  const host = maybeUrl?.hostname ?? trimmed;
  return host
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function matchProxyDomain(hostname: string, domains: readonly string[]): string | undefined {
  for (const domain of domains) {
    if (domain === "*" || hostname === domain || hostname.endsWith(`.${domain}`)) {
      return domain;
    }
  }
  return undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function parseMaybeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch (_error) {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
