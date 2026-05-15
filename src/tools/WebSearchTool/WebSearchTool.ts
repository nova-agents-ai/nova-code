/** WebSearchTool —— search the public web via a lightweight HTML endpoint. */

import { ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import { describeType, optionalBooleanField, requireStringField } from "../utils.ts";
import { stripHtmlTags, truncateText } from "../WebFetchTool/extractReadableText.ts";
import { fetchWebContent, parseHttpUrl } from "../WebFetchTool/fetchWebContent.ts";
import { formatProxyDecision } from "../WebFetchTool/webProxyConfig.ts";
import {
  WEB_SEARCH_DEFAULT_ENDPOINT,
  WEB_SEARCH_MAX_HTML_CHARS,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_TOOL_NAME,
} from "./constants.ts";

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
}

export const WebSearchTool: Tool = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    "Search the public web for current information and return result titles with URLs. " +
    "Supports optional allowed_domains or blocked_domains filters.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The web search query." },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Optional domains to include, e.g. ['docs.python.org'].",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Optional domains to exclude, e.g. ['example.com'].",
      },
      use_proxy: {
        type: "boolean",
        description:
          "Set true when the search endpoint is likely blocked or requires the configured web proxy.",
      },
    },
    required: ["query"],
  },
  requiresApproval: false,
  execute: async (input, context) => {
    const parsedInput = parseWebSearchInput(input);
    const endpoint = buildSearchUrl(parsedInput.query);
    const fetched = await fetchWebContent({
      url: endpoint,
      signal: context.signal,
      toolName: WEB_SEARCH_TOOL_NAME,
      accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
      useProxy: parsedInput.useProxy,
    });
    const html = truncateText(fetched.rawText, WEB_SEARCH_MAX_HTML_CHARS).text;
    const results = parseWebSearchResults(html).filter((result) =>
      shouldKeepResult(result, parsedInput),
    );
    return formatSearchResults(
      parsedInput.query,
      results.slice(0, WEB_SEARCH_MAX_RESULTS),
      formatProxyDecision({
        source: fetched.proxySource,
        matchedDomain: fetched.proxyMatchedDomain,
      }),
    );
  },
};

interface WebSearchInput {
  readonly query: string;
  readonly allowedDomains: readonly string[];
  readonly blockedDomains: readonly string[];
  readonly useProxy: boolean | undefined;
}

export function parseWebSearchResults(html: string): readonly WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attrs = match[1] ?? "";
    const innerHtml = match[2] ?? "";
    const href = extractHref(attrs);
    if (href === undefined) continue;
    const url = normalizeResultUrl(href);
    if (url === undefined || seenUrls.has(url)) continue;
    const title = stripHtmlTags(innerHtml);
    if (title === "") continue;
    seenUrls.add(url);
    results.push({ title, url });
  }
  return results;
}

function parseWebSearchInput(input: Readonly<Record<string, unknown>>): WebSearchInput {
  const query = requireStringField(input, "query", WEB_SEARCH_TOOL_NAME).trim();
  if (query.length < 2) {
    throw new ToolExecutionError(
      WEB_SEARCH_TOOL_NAME,
      "Field 'query' must contain at least 2 characters.",
    );
  }
  const allowedDomains = parseDomainList(input["allowed_domains"], "allowed_domains");
  const blockedDomains = parseDomainList(input["blocked_domains"], "blocked_domains");
  const useProxy = optionalBooleanField(input, "use_proxy", WEB_SEARCH_TOOL_NAME);
  if (allowedDomains.length > 0 && blockedDomains.length > 0) {
    throw new ToolExecutionError(
      WEB_SEARCH_TOOL_NAME,
      "Cannot specify both allowed_domains and blocked_domains.",
    );
  }
  return { query, allowedDomains, blockedDomains, useProxy };
}

function parseDomainList(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ToolExecutionError(
      WEB_SEARCH_TOOL_NAME,
      `${field} must be an array of strings. Got ${describeType(value)}.`,
    );
  }
  return value.map((item, index) => parseDomain(item, `${field}[${index}]`));
}

function parseDomain(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolExecutionError(
      WEB_SEARCH_TOOL_NAME,
      `${field} must be a non-empty string. Got ${describeType(value)}.`,
    );
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function buildSearchUrl(query: string): string {
  const endpoint = process.env["NOVA_WEB_SEARCH_ENDPOINT"] ?? WEB_SEARCH_DEFAULT_ENDPOINT;
  const url = parseHttpUrl(endpoint, WEB_SEARCH_TOOL_NAME);
  url.searchParams.set("q", query);
  return url.toString();
}

function extractHref(attributes: string): string | undefined {
  const match = attributes.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function normalizeResultUrl(rawHref: string): string | undefined {
  const decodedHref = rawHref.replaceAll("&amp;", "&");
  const directUrl = parseMaybeUrl(decodedHref);
  if (directUrl !== undefined) return directUrl;

  if (!decodedHref.startsWith("/")) return undefined;
  const placeholder = new URL(decodedHref, "https://duckduckgo.com");
  const redirected = placeholder.searchParams.get("uddg");
  if (redirected === null) return undefined;
  return parseMaybeUrl(redirected);
}

function parseMaybeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function shouldKeepResult(result: WebSearchResult, input: WebSearchInput): boolean {
  const hostname = getNormalizedHostname(result.url);
  if (hostname === undefined) return false;
  if (input.allowedDomains.length > 0) {
    return input.allowedDomains.some((domain) => matchesDomain(hostname, domain));
  }
  if (input.blockedDomains.length > 0) {
    return !input.blockedDomains.some((domain) => matchesDomain(hostname, domain));
  }
  return true;
}

function getNormalizedHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function formatSearchResults(
  query: string,
  results: readonly WebSearchResult[],
  proxyLine: string,
): string {
  if (results.length === 0) {
    return [`No web search results found for "${query}".`, proxyLine]
      .filter((line) => line !== "")
      .join("\n");
  }
  const lines = [`Search results for "${query}":`];
  if (proxyLine !== "") {
    lines.push(proxyLine);
  }
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
  });
  return lines.join("\n");
}
