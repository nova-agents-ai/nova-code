/** HTML / text extraction helpers for WebFetch and WebSearch. */

const HTML_TAG_PATTERN = /<[^>]+>/g;
const HTML_TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

const ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/** Convert HTML into compact readable text; plain text is normalized only. */
export function extractReadableText(rawText: string, contentType: string): string {
  if (!isHtmlContent(contentType, rawText)) return normalizeText(rawText);

  const title = extractTitle(rawText);
  const withoutNoise = rawText
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  const withLineBreaks = withoutNoise
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6]|blockquote)>/gi, "\n");
  const body = normalizeText(decodeHtmlEntities(withLineBreaks.replace(HTML_TAG_PATTERN, " ")));
  if (title === undefined || body.startsWith(title)) return body;
  return normalizeText(`# ${title}\n\n${body}`);
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => decodeCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      decodeCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITY_MAP[name.toLowerCase()] ?? match);
}

export function stripHtmlTags(value: string): string {
  return normalizeText(decodeHtmlEntities(value.replace(HTML_TAG_PATTERN, " ")));
}

export function truncateText(
  value: string,
  maxChars: number,
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function extractTitle(html: string): string | undefined {
  const match = html.match(HTML_TITLE_PATTERN);
  const rawTitle = match?.[1];
  if (rawTitle === undefined) return undefined;
  const title = stripHtmlTags(rawTitle);
  return title === "" ? undefined : title;
}

function isHtmlContent(contentType: string, rawText: string): boolean {
  return contentType.toLowerCase().includes("html") || /<html\b|<body\b|<title\b/i.test(rawText);
}

function decodeCodePoint(codePoint: number): string {
  if (!Number.isFinite(codePoint)) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}
