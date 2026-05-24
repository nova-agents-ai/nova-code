import { type AttachmentMention, AttachmentMentionKind } from "./types.ts";

const AT_SIGN = "@";
const MCP_PREFIX = "MCP__";
const EXPLICIT_FILE_PREFIX = "file:";
const EXPLICIT_DIR_PREFIX = "dir:";
const EXPLICIT_GLOB_PREFIX = "glob:";
const MAX_MENTION_CHARS = 1_000;

export function parseAttachmentMentions(prompt: string): readonly AttachmentMention[] {
  const mentions: AttachmentMention[] = [];
  let index = 0;
  while (index < prompt.length) {
    const char = prompt[index];
    if (char !== AT_SIGN || !canStartMention(prompt, index)) {
      index += 1;
      continue;
    }

    const parsed = readMentionToken(prompt, index);
    if (parsed === undefined) {
      index += 1;
      continue;
    }
    const mention = parseMentionToken(parsed.raw);
    if (mention !== undefined) mentions.push(mention);
    index = parsed.end;
  }
  return mentions;
}

function canStartMention(prompt: string, index: number): boolean {
  if (index === 0) return true;
  const previous = prompt[index - 1] ?? "";
  return /\s|[([{:;,，。！？!]/.test(previous);
}

function readMentionToken(
  prompt: string,
  start: number,
): { readonly raw: string; readonly end: number } | undefined {
  const afterAt = prompt.slice(start + 1);
  const functionEnd = readFunctionStyleEnd(afterAt);
  if (functionEnd !== undefined) {
    return { raw: prompt.slice(start, start + 1 + functionEnd), end: start + 1 + functionEnd };
  }

  let end = start + 1;
  while (end < prompt.length && !isMentionTerminator(prompt[end] ?? "")) {
    if (end - start > MAX_MENTION_CHARS) break;
    end += 1;
  }
  const raw = trimTrailingPunctuation(prompt.slice(start, end));
  if (raw.length <= 1) return undefined;
  return { raw, end: start + raw.length };
}

function readFunctionStyleEnd(textAfterAt: string): number | undefined {
  const openParenIndex = textAfterAt.indexOf("(");
  if (openParenIndex <= 0) return undefined;
  const name = textAfterAt.slice(0, openParenIndex);
  if (name !== "file" && name !== "dir" && name !== "glob") return undefined;
  // Walk forward with a depth counter so paths like `path/(x).ts` don't get
  // chopped at the first inner `)`.
  let depth = 1;
  for (let cursor = openParenIndex + 1; cursor < textAfterAt.length; cursor += 1) {
    const char = textAfterAt[cursor];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return undefined;
}

function isMentionTerminator(char: string): boolean {
  return /\s|[<>"'`，。！？!,;；]/.test(char);
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[)）\]}】.。,:;；!?！？]+$/u, "");
}

function parseMentionToken(raw: string): AttachmentMention | undefined {
  const token = raw.slice(1).trim();
  if (token === "") return undefined;
  const functionStyle = parseFunctionStyleToken(raw, token);
  if (functionStyle !== undefined) return functionStyle;
  if (token.startsWith(MCP_PREFIX)) return parseMcpMention(raw, token);
  if (token.startsWith(EXPLICIT_FILE_PREFIX)) {
    return parseExplicitPath(
      raw,
      AttachmentMentionKind.FILE,
      token.slice(EXPLICIT_FILE_PREFIX.length),
    );
  }
  if (token.startsWith(EXPLICIT_DIR_PREFIX)) {
    return parseExplicitPath(
      raw,
      AttachmentMentionKind.DIRECTORY,
      token.slice(EXPLICIT_DIR_PREFIX.length),
    );
  }
  if (token.startsWith(EXPLICIT_GLOB_PREFIX)) {
    return parseExplicitPath(
      raw,
      AttachmentMentionKind.GLOB,
      token.slice(EXPLICIT_GLOB_PREFIX.length),
    );
  }
  return {
    kind: hasGlobMagic(token) ? AttachmentMentionKind.GLOB : AttachmentMentionKind.PATH,
    raw,
    value: token,
  };
}

function parseFunctionStyleToken(raw: string, token: string): AttachmentMention | undefined {
  if (token.startsWith("file(") && token.endsWith(")")) {
    return parseExplicitPath(raw, AttachmentMentionKind.FILE, token.slice(5, -1));
  }
  if (token.startsWith("dir(") && token.endsWith(")")) {
    return parseExplicitPath(raw, AttachmentMentionKind.DIRECTORY, token.slice(4, -1));
  }
  if (token.startsWith("glob(") && token.endsWith(")")) {
    return parseExplicitPath(raw, AttachmentMentionKind.GLOB, token.slice(5, -1));
  }
  return undefined;
}

function parseMcpMention(raw: string, token: string): AttachmentMention | undefined {
  const parts = token.split("__");
  const serverName = parts[1];
  const uri = parts.slice(2).join("__");
  if (serverName === undefined || serverName === "" || uri === "") return undefined;
  return {
    kind: AttachmentMentionKind.MCP_RESOURCE,
    raw,
    value: token,
    serverName,
    uri,
  };
}

function parseExplicitPath(
  raw: string,
  kind: AttachmentMentionKind,
  value: string,
): AttachmentMention | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return { kind, raw, value: trimmed };
}

function hasGlobMagic(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}
