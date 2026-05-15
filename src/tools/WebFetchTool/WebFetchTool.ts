/** WebFetchTool —— fetch a public URL and extract readable text. */

import { ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import { describeType, optionalBooleanField, requireStringField } from "../utils.ts";
import { WEB_FETCH_MAX_CHARS, WEB_FETCH_TOOL_NAME } from "./constants.ts";
import { extractReadableText, truncateText } from "./extractReadableText.ts";
import { fetchWebContent } from "./fetchWebContent.ts";
import { formatProxyDecision } from "./webProxyConfig.ts";

export const WebFetchTool: Tool = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    "Fetch a public HTTP(S) URL and extract readable text from HTML, plain text, JSON, or XML. " +
    "Use this for public web pages only; it cannot access authenticated or private pages.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The public HTTP(S) URL to fetch.",
      },
      prompt: {
        type: "string",
        description:
          "Optional focus or question to answer from the fetched content. The tool returns extracted content for the model to use.",
      },
      use_proxy: {
        type: "boolean",
        description:
          "Set true when the target website is likely blocked or requires the configured web proxy.",
      },
    },
    required: ["url"],
  },
  requiresApproval: false,
  execute: async (input, context) => {
    const url = requireStringField(input, "url", WEB_FETCH_TOOL_NAME);
    const prompt = parseOptionalString(input["prompt"]);
    const useProxy = optionalBooleanField(input, "use_proxy", WEB_FETCH_TOOL_NAME);
    const fetched = await fetchWebContent({
      url,
      signal: context.signal,
      toolName: WEB_FETCH_TOOL_NAME,
      useProxy,
    });
    const extracted = extractReadableText(fetched.rawText, fetched.contentType);
    const truncated = truncateText(extracted, WEB_FETCH_MAX_CHARS);
    return formatFetchResult({
      fetched,
      prompt,
      content: truncated.text,
      truncated: truncated.truncated,
    });
  },
};

interface FormatFetchResultParams {
  readonly fetched: Awaited<ReturnType<typeof fetchWebContent>>;
  readonly prompt: string | undefined;
  readonly content: string;
  readonly truncated: boolean;
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolExecutionError(
      WEB_FETCH_TOOL_NAME,
      `Optional field 'prompt' must be a string. Got ${describeType(value)}.`,
    );
  }
  return value.trim() === "" ? undefined : value;
}

function formatFetchResult(params: FormatFetchResultParams): string {
  const { fetched, prompt, content, truncated } = params;
  const lines = [
    `Fetched: ${fetched.finalUrl}`,
    `Status: ${fetched.status} ${fetched.statusText || "OK"}`,
    `Content-Type: ${fetched.contentType || "unknown"}`,
    `Bytes: ${fetched.bytes}${fetched.byteTruncated ? " (truncated by bytes)" : ""}${truncated ? " (truncated by chars)" : ""}`,
  ];
  const proxyLine = formatProxyDecision({
    source: fetched.proxySource,
    matchedDomain: fetched.proxyMatchedDomain,
  });
  if (proxyLine !== "") {
    lines.push(proxyLine);
  }
  if (fetched.finalUrl !== fetched.requestedUrl) {
    lines.push(`Requested URL: ${fetched.requestedUrl}`);
  }
  if (prompt !== undefined) {
    lines.push(`Prompt: ${prompt}`);
  }
  lines.push("", content === "" ? "(no readable text extracted)" : content);
  return lines.join("\n");
}
