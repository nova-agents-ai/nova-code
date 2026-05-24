import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AbortError } from "../../errors/index.ts";
import type {
  ImageMediaType,
  NovaContentBlock,
  NovaMessage,
  TextBlock,
} from "../../types/message.ts";
import { parseAttachmentMentions } from "./parser.ts";
import {
  AttachmentMentionKind,
  type ExtraPromptAttachment,
  ResolvedAttachmentKind,
  type ResolvedPromptAttachment,
  type ResolvedPromptAttachments,
  type ResolvePromptAttachmentsParams,
} from "./types.ts";

// Text budget covers ~24K UTF-16 chars; multiply by 4 to upper-bound the byte
// budget for worst-case 4-byte UTF-8 codepoints, but cap so we don't read
// orders of magnitude more than we surface.
const MAX_TEXT_ATTACHMENT_CHARS = 24_000;
const MAX_FILE_READ_BYTES = 32_000;
const MAX_DIRECTORY_ENTRIES = 120;
const MAX_GLOB_MATCHES = 20;
const MAX_GLOB_SCAN_RESULTS = 500;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_MCP_TEXT_CHARS = 24_000;
const BINARY_DETECT_BYTES = 4_096;

interface ResolveState {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly seenFilePaths: Set<string>;
  readonly seenAttachmentKeys: Set<string>;
  readonly warnings: string[];
}

type FileSystemStats = Awaited<ReturnType<typeof stat>>;

export async function resolvePromptAttachments(
  params: ResolvePromptAttachmentsParams,
): Promise<ResolvedPromptAttachments> {
  const state: ResolveState = {
    cwd: params.cwd,
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    seenFilePaths: new Set<string>(),
    seenAttachmentKeys: new Set<string>(),
    warnings: [],
  };
  const attachments: ResolvedPromptAttachment[] = [];

  for (const mention of parseAttachmentMentions(params.prompt)) {
    throwIfAborted(params.signal);
    attachments.push(...(await resolveMention(mention, params, state)));
  }
  attachments.push(...resolveExtraAttachments(params.extraAttachments ?? []));

  const activatedRules = await activateRulesForAttachments(params, attachments);
  const content = buildPromptContent(params.prompt, attachments);
  return {
    prompt: params.prompt,
    content,
    attachments,
    warnings: state.warnings,
    activatedRules,
  };
}

async function resolveMention(
  mention: ReturnType<typeof parseAttachmentMentions>[number],
  params: ResolvePromptAttachmentsParams,
  state: ResolveState,
): Promise<readonly ResolvedPromptAttachment[]> {
  const dedupeKey = `${mention.kind}:${mention.value}`;
  if (state.seenAttachmentKeys.has(dedupeKey)) return [];
  state.seenAttachmentKeys.add(dedupeKey);

  if (mention.kind === AttachmentMentionKind.MCP_RESOURCE) {
    return await resolveMcpMention(mention, params, state);
  }
  if (mention.kind === AttachmentMentionKind.GLOB) {
    return await resolveGlobMention(mention.value, state);
  }
  return await resolvePathMention(mention.kind, mention.value, state);
}

async function resolvePathMention(
  kind: AttachmentMentionKind,
  value: string,
  state: ResolveState,
): Promise<readonly ResolvedPromptAttachment[]> {
  // Bare `@~` would otherwise dump the entire home directory — too large a
  // blast radius for a single character. Require an explicit path under home.
  if (value === "~") {
    state.warnings.push(
      `Attachment '${value}' refused: bare home-directory reference is not allowed; use '@~/some/path' instead.`,
    );
    return [];
  }
  const absolutePath = resolveInputPath(value, state.cwd);
  const stats = await safeStat(absolutePath);
  if (stats === undefined) {
    state.warnings.push(`Attachment '${value}' not found or not readable.`);
    return [];
  }
  if (stats.isDirectory()) {
    if (kind === AttachmentMentionKind.FILE) {
      state.warnings.push(`Attachment '${value}' is a directory, not a file.`);
      return [];
    }
    return await resolveDirectoryAttachment(absolutePath, stats, state);
  }
  if (!stats.isFile()) {
    state.warnings.push(`Attachment '${value}' is not a regular file or directory.`);
    return [];
  }
  if (kind === AttachmentMentionKind.DIRECTORY) {
    state.warnings.push(`Attachment '${value}' is a file, not a directory.`);
    return [];
  }
  return await resolveFileAttachment(absolutePath, stats, state, "file");
}

async function resolveGlobMention(
  pattern: string,
  state: ResolveState,
): Promise<readonly ResolvedPromptAttachment[]> {
  const trimmedPattern = pattern.trim();
  if (trimmedPattern.startsWith("~") || isAbsolute(trimmedPattern)) {
    // Bun.Glob.scan is rooted at cwd; absolute and `~/` patterns silently
    // match nothing. Reject explicitly so the user notices.
    state.warnings.push(
      `Attachment glob '${pattern}' refused: glob patterns must be relative to the project root (got absolute or '~/' prefix).`,
    );
    return [];
  }
  const matchedPaths = await scanGlob(trimmedPattern, state);
  if (matchedPaths.length === 0) {
    state.warnings.push(`Attachment glob '${pattern}' matched no files.`);
    return [];
  }

  const selectedPaths = matchedPaths.slice(0, MAX_GLOB_MATCHES);
  const attachments: ResolvedPromptAttachment[] = [
    createTextAttachment({
      kind: ResolvedAttachmentKind.GLOB,
      label: `glob ${pattern}`,
      path: pattern,
      referencedFilePaths: selectedPaths,
      truncated: matchedPaths.length > selectedPaths.length,
      text: formatGlobSummary(pattern, matchedPaths, state.cwd),
    }),
  ];

  for (const matchedPath of selectedPaths) {
    const stats = await safeStat(matchedPath);
    if (stats?.isFile() !== true) continue;
    attachments.push(
      ...(await resolveFileAttachment(matchedPath, stats, state, `glob ${pattern}`)),
    );
  }
  return attachments;
}

function looksBinary(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, BINARY_DETECT_BYTES);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function bytesToString(bytes: Uint8Array): string {
  // fatal:false silently emits replacement characters; the slice may end mid
  // codepoint after MAX_FILE_READ_BYTES, so we accept that single-char artifact
  // rather than crashing. The text is bounded again by truncateText().
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function resolveFileAttachment(
  absolutePath: string,
  stats: FileSystemStats,
  state: ResolveState,
  sourceLabel: string,
): Promise<readonly ResolvedPromptAttachment[]> {
  const normalizedPath = resolve(absolutePath);
  if (state.seenFilePaths.has(normalizedPath)) return [];
  state.seenFilePaths.add(normalizedPath);

  const mediaType = getImageMediaType(normalizedPath);
  if (mediaType !== undefined) {
    return await resolveImageAttachment(normalizedPath, stats, mediaType, state, sourceLabel);
  }
  return await resolveTextFileAttachment(normalizedPath, stats, state, sourceLabel);
}

async function resolveTextFileAttachment(
  absolutePath: string,
  stats: FileSystemStats,
  state: ResolveState,
  sourceLabel: string,
): Promise<readonly ResolvedPromptAttachment[]> {
  const displayPath = formatDisplayPath(absolutePath, state.cwd);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      await Bun.file(absolutePath).slice(0, MAX_FILE_READ_BYTES).arrayBuffer(),
    );
  } catch (error) {
    state.warnings.push(`Attachment '${displayPath}' could not be read: ${describeError(error)}.`);
    return [];
  }

  if (looksBinary(bytes)) {
    return [
      createTextAttachment({
        kind: ResolvedAttachmentKind.FILE,
        label: `${sourceLabel}: ${displayPath}`,
        path: absolutePath,
        referencedFilePaths: [absolutePath],
        truncated: true,
        text: `<attachment type="file" path="${displayPath}" bytes="${stats.size}" binary="true">[binary file omitted: ${stats.size} bytes]</attachment>`,
      }),
    ];
  }

  const rawText = bytesToString(bytes);
  const contentText = truncateText(rawText, MAX_TEXT_ATTACHMENT_CHARS, "characters");
  const truncated = stats.size > MAX_FILE_READ_BYTES || rawText.length > contentText.length;
  return [
    createTextAttachment({
      kind: ResolvedAttachmentKind.FILE,
      label: `${sourceLabel}: ${displayPath}`,
      path: absolutePath,
      referencedFilePaths: [absolutePath],
      truncated,
      text: [
        `<attachment type="file" path="${displayPath}" bytes="${stats.size}" truncated="${String(truncated)}">`,
        contentText,
        "</attachment>",
      ].join("\n"),
    }),
  ];
}

async function resolveImageAttachment(
  absolutePath: string,
  stats: FileSystemStats,
  mediaType: ImageMediaType,
  state: ResolveState,
  sourceLabel: string,
): Promise<readonly ResolvedPromptAttachment[]> {
  const displayPath = formatDisplayPath(absolutePath, state.cwd);
  if (stats.size > MAX_IMAGE_BYTES) {
    state.warnings.push(`Image attachment '${displayPath}' is too large (${stats.size} bytes).`);
    return [
      createTextAttachment({
        kind: ResolvedAttachmentKind.FILE,
        label: `${sourceLabel}: ${displayPath}`,
        path: absolutePath,
        // Image kinds intentionally do NOT propagate referencedFilePaths so
        // they don't activate path-scoped rules — see M14 design §4.
        referencedFilePaths: [],
        truncated: true,
        text: `<attachment type="file" path="${displayPath}">[image omitted: too large]</attachment>`,
      }),
    ];
  }

  let data: string;
  try {
    data = Buffer.from(await Bun.file(absolutePath).arrayBuffer()).toString("base64");
  } catch (error) {
    state.warnings.push(
      `Image attachment '${displayPath}' could not be read: ${describeError(error)}.`,
    );
    return [];
  }
  return [
    {
      kind: ResolvedAttachmentKind.IMAGE,
      label: `${sourceLabel}: ${displayPath}`,
      path: absolutePath,
      referencedFilePaths: [],
      truncated: false,
      image: {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      },
    },
  ];
}

async function resolveDirectoryAttachment(
  absolutePath: string,
  stats: FileSystemStats,
  state: ResolveState,
): Promise<readonly ResolvedPromptAttachment[]> {
  const displayPath = formatDisplayPath(absolutePath, state.cwd);
  let rawEntries: Dirent<string>[];
  try {
    rawEntries = await readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    state.warnings.push(
      `Directory attachment '${displayPath}' could not be read: ${describeError(error)}.`,
    );
    return [];
  }
  const sortedEntries = [...rawEntries].sort((left, right) => left.name.localeCompare(right.name));
  const selectedEntries = sortedEntries.slice(0, MAX_DIRECTORY_ENTRIES);
  const referencedFilePaths = selectedEntries
    .filter((entry) => entry.isFile())
    .map((entry) => join(absolutePath, entry.name));
  const truncated = sortedEntries.length > selectedEntries.length;
  return [
    createTextAttachment({
      kind: ResolvedAttachmentKind.DIRECTORY,
      label: `directory: ${displayPath}`,
      path: absolutePath,
      referencedFilePaths,
      truncated,
      text: [
        `<attachment type="directory" path="${displayPath}" entries="${sortedEntries.length}" bytes="${stats.size}">`,
        ...selectedEntries.map(formatDirectoryEntry),
        truncated ? `[truncated at ${MAX_DIRECTORY_ENTRIES} entries]` : "",
        "</attachment>",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    }),
  ];
}

async function resolveMcpMention(
  mention: ReturnType<typeof parseAttachmentMentions>[number],
  params: ResolvePromptAttachmentsParams,
  state: ResolveState,
): Promise<readonly ResolvedPromptAttachment[]> {
  if (params.mcpRegistry === undefined) {
    state.warnings.push(`MCP attachment '${mention.raw}' skipped: no MCP registry configured.`);
    return [];
  }
  if (mention.serverName === undefined || mention.uri === undefined) return [];

  let result: Awaited<ReturnType<typeof params.mcpRegistry.readResource>>;
  try {
    result = await params.mcpRegistry.readResource(mention.serverName, mention.uri, params.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.warnings.push(`MCP attachment '${mention.raw}' failed: ${message}`);
    return [];
  }
  const text = formatMcpResource(mention.serverName, mention.uri, result);
  return [
    createTextAttachment({
      kind: ResolvedAttachmentKind.MCP_RESOURCE,
      label: `mcp: ${mention.serverName} ${mention.uri}`,
      referencedFilePaths: [],
      truncated: text.length > MAX_MCP_TEXT_CHARS,
      text: truncateText(text, MAX_MCP_TEXT_CHARS, "characters"),
    }),
  ];
}

function resolveExtraAttachments(
  extras: readonly ExtraPromptAttachment[],
): readonly ResolvedPromptAttachment[] {
  return extras.map((extra) => {
    if (extra.kind === ResolvedAttachmentKind.IMAGE) {
      return {
        kind: ResolvedAttachmentKind.IMAGE,
        label: extra.label,
        referencedFilePaths: [],
        truncated: false,
        image: extra.image,
      };
    }
    return createTextAttachment({
      kind: ResolvedAttachmentKind.PASTE_TEXT,
      label: extra.label,
      referencedFilePaths: [],
      truncated: false,
      text: extra.text,
    });
  });
}

async function activateRulesForAttachments(
  params: ResolvePromptAttachmentsParams,
  attachments: readonly ResolvedPromptAttachment[],
) {
  if (params.projectInstructionsRuntime === undefined) return [];
  const activated = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    for (const path of attachment.referencedFilePaths) {
      const absolutePath = resolve(path);
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      activated.push(
        ...(await params.projectInstructionsRuntime.activateForPath({
          path: absolutePath,
          cwd: params.cwd,
        })),
      );
    }
  }
  return activated;
}

function buildPromptContent(
  prompt: string,
  attachments: readonly ResolvedPromptAttachment[],
): NovaMessage["content"] {
  if (attachments.length === 0) return prompt;
  const blocks: NovaContentBlock[] = [
    { type: "text", text: prompt },
    formatAttachmentSummary(attachments),
  ];
  for (const attachment of attachments) {
    if (attachment.text !== undefined) {
      blocks.push({ type: "text", text: attachment.text });
    }
    if (attachment.image !== undefined) {
      blocks.push({ type: "text", text: `<attachment type="image" label="${attachment.label}">` });
      blocks.push(attachment.image);
    }
  }
  return blocks;
}

function formatAttachmentSummary(attachments: readonly ResolvedPromptAttachment[]): TextBlock {
  const lines = attachments.map((attachment) => {
    const suffix = attachment.truncated ? " (truncated)" : "";
    return `- ${attachment.kind.toLowerCase()}: ${attachment.label}${suffix}`;
  });
  return {
    type: "text",
    text: ["<attachments_summary>", ...lines, "</attachments_summary>"].join("\n"),
  };
}

function createTextAttachment(params: {
  readonly kind: ResolvedAttachmentKind;
  readonly label: string;
  readonly text: string;
  readonly referencedFilePaths: readonly string[];
  readonly truncated: boolean;
  readonly path?: string;
}): ResolvedPromptAttachment {
  return {
    kind: params.kind,
    label: params.label,
    text: params.text,
    referencedFilePaths: params.referencedFilePaths,
    truncated: params.truncated,
    ...(params.path !== undefined ? { path: params.path } : {}),
  };
}

async function scanGlob(pattern: string, state: ResolveState): Promise<readonly string[]> {
  const normalizedPattern = normalizeGlobPattern(pattern);
  const glob = new Bun.Glob(normalizedPattern);
  const paths: string[] = [];
  for await (const path of glob.scan({
    cwd: state.cwd,
    onlyFiles: true,
    dot: true,
    absolute: true,
  })) {
    throwIfAborted(state.signal);
    paths.push(path);
    // Hard cap so `**/*` on huge trees doesn't burn IO long after we already
    // have far more matches than we'll ever surface.
    if (paths.length >= MAX_GLOB_SCAN_RESULTS) break;
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function formatGlobSummary(pattern: string, matchedPaths: readonly string[], cwd: string): string {
  const selectedPaths = matchedPaths.slice(0, MAX_GLOB_MATCHES);
  const lines = selectedPaths.map((path) => `- ${formatDisplayPath(path, cwd)}`);
  const truncated = matchedPaths.length > selectedPaths.length;
  return [
    `<attachment type="glob" pattern="${pattern}" matches="${matchedPaths.length}" truncated="${String(truncated)}">`,
    ...lines,
    truncated ? `[truncated at ${MAX_GLOB_MATCHES} matches]` : "",
    "</attachment>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatDirectoryEntry(entry: {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}): string {
  if (entry.isDirectory()) return `- ${entry.name}/`;
  if (entry.isFile()) return `- ${entry.name}`;
  return `- ${entry.name} (other)`;
}

function formatMcpResource(
  serverName: string,
  uri: string,
  result: { readonly contents: readonly Readonly<Record<string, unknown>>[] },
): string {
  const lines = [`<attachment type="mcp_resource" server="${serverName}" uri="${uri}">`];
  for (const content of result.contents) {
    const contentUri = typeof content["uri"] === "string" ? content["uri"] : uri;
    const mimeType = typeof content["mimeType"] === "string" ? content["mimeType"] : "unknown";
    if (typeof content["text"] === "string") {
      lines.push(`--- ${contentUri} (${mimeType}) ---`);
      lines.push(content["text"]);
      continue;
    }
    if (typeof content["blob"] === "string") {
      lines.push(`--- ${contentUri} (${mimeType}) ---`);
      lines.push(`[blob: ${content["blob"].length} base64 chars]`);
    }
  }
  lines.push("</attachment>");
  return lines.join("\n");
}

function resolveInputPath(value: string, cwd: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function formatDisplayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  if (relativePath === "" || isAbsolute(relativePath) || isOutsideRelativePath(relativePath)) {
    return path.split(sep).join("/");
  }
  return relativePath.split(sep).join("/");
}

function isOutsideRelativePath(relativePath: string): boolean {
  // Reject only `..` segments — bare prefix matching would over-reject valid
  // filenames like `..foo.txt` that simply start with two dots.
  return relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

function normalizeGlobPattern(pattern: string): string {
  const trimmed = pattern.trim().replaceAll("\\", "/");
  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}

function truncateText(text: string, maxUnits: number, unit: string): string {
  if (text.length <= maxUnits) return text;
  return `${text.slice(0, maxUnits)}\n[truncated at ${maxUnits} ${unit}]`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeStat(path: string): Promise<FileSystemStats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function getImageMediaType(path: string): ImageMediaType | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    // Throw nova's AbortError so ask/chat error-mapping (instanceof checks)
    // produces [cancelled] / exit 130, matching the rest of the agent loop.
    throw new AbortError();
  }
}

function errnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
