/** Fetch helpers shared by M7 web tools. */

import { ToolExecutionError } from "../../errors/index.ts";
import { describeError } from "../utils.ts";
import { WEB_FETCH_MAX_BYTES, WEB_FETCH_TIMEOUT_MS, WEB_USER_AGENT } from "./constants.ts";
import { decideWebProxy, type WebProxyDecision } from "./webProxyConfig.ts";

const TEXTUAL_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
];
const PRIVATE_HOST_OVERRIDE_ENV = "NOVA_WEB_ALLOW_PRIVATE_HOSTS";

export interface FetchedWebContent {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly byteTruncated: boolean;
  readonly rawText: string;
  readonly proxyUsed: boolean;
  readonly proxySource: WebProxyDecision["source"];
  readonly proxyMatchedDomain: string | undefined;
}

export async function fetchWebContent(params: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly toolName: string;
  readonly accept?: string;
  readonly useProxy?: boolean;
}): Promise<FetchedWebContent> {
  const parsedUrl = parseHttpUrl(params.url, params.toolName);
  const proxyDecision = await decideWebProxy({
    url: parsedUrl,
    forceProxy: params.useProxy ?? false,
    toolName: params.toolName,
  });
  const abort = createTimeoutSignal(params.signal, WEB_FETCH_TIMEOUT_MS);
  try {
    const init: RequestInit & { proxy?: string } = {
      signal: abort.signal,
      headers: {
        Accept: params.accept ?? "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        "User-Agent": WEB_USER_AGENT,
      },
      ...(proxyDecision.proxyUrl !== undefined ? { proxy: proxyDecision.proxyUrl } : {}),
    };
    const response = await fetch(parsedUrl, init);
    return await readResponse(response, parsedUrl.toString(), params.toolName, proxyDecision);
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throw new ToolExecutionError(
      params.toolName,
      `Failed to fetch ${parsedUrl}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  } finally {
    abort.dispose();
  }
}

export function parseHttpUrl(rawUrl: string, toolName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new ToolExecutionError(toolName, `Invalid URL '${rawUrl}': ${describeError(error)}`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolExecutionError(toolName, `URL must use http or https. Got ${parsed.protocol}`);
  }
  assertPublicHost(parsed, toolName);
  return parsed;
}

function assertPublicHost(url: URL, toolName: string): void {
  if (process.env[PRIVATE_HOST_OVERRIDE_ENV] === "1") return;

  const hostname = normalizeHostname(url.hostname);
  if (!isPrivateOrLocalHost(hostname)) return;

  throw new ToolExecutionError(
    toolName,
    `Refusing to fetch private/local host '${hostname}'. Set ${PRIVATE_HOST_OVERRIDE_ENV}=1 only for local testing.`,
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isPrivateOrLocalHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) return isPrivateIpv4(ipv4);
  return isPrivateIpv6(hostname);
}

function parseIpv4(hostname: string): readonly [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  if (!parts.every((part) => /^\d+$/.test(part))) return undefined;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return [a, b, c, d];
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  return (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:") ||
    hostname.startsWith("::ffff:127.")
  );
}

async function readResponse(
  response: Response,
  requestedUrl: string,
  toolName: string,
  proxyDecision: WebProxyDecision,
): Promise<FetchedWebContent> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    throw new ToolExecutionError(
      toolName,
      `HTTP ${response.status} ${response.statusText || "Unknown"} while fetching ${requestedUrl}.`,
    );
  }
  if (!isTextualContent(contentType)) {
    throw new ToolExecutionError(
      toolName,
      `Unsupported content-type '${contentType || "unknown"}' from ${requestedUrl}.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const byteTruncated = bytes.byteLength > WEB_FETCH_MAX_BYTES;
  const visibleBytes = byteTruncated ? bytes.slice(0, WEB_FETCH_MAX_BYTES) : bytes;
  return {
    requestedUrl,
    finalUrl: response.url || requestedUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    bytes: bytes.byteLength,
    byteTruncated,
    rawText: new TextDecoder("utf-8", { fatal: false }).decode(visibleBytes),
    proxyUsed: proxyDecision.proxyUrl !== undefined,
    proxySource: proxyDecision.source,
    proxyMatchedDomain: proxyDecision.matchedDomain,
  };
}

function isTextualContent(contentType: string): boolean {
  if (contentType === "") return true;
  const normalized = contentType.toLowerCase();
  return TEXTUAL_CONTENT_TYPES.some((prefix) => normalized.includes(prefix));
}

function createTimeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Web request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}
