import type { ImageBlock, NovaMessage } from "../../types/message.ts";
import type { McpReadResourceResult } from "../mcp/index.ts";
import type {
  ProjectInstructionsRuntime,
  ProjectRuleActivation,
} from "../projectInstructions/index.ts";

export enum AttachmentMentionKind {
  PATH = "PATH",
  FILE = "FILE",
  DIRECTORY = "DIRECTORY",
  GLOB = "GLOB",
  MCP_RESOURCE = "MCP_RESOURCE",
}

export enum ResolvedAttachmentKind {
  FILE = "FILE",
  DIRECTORY = "DIRECTORY",
  GLOB = "GLOB",
  MCP_RESOURCE = "MCP_RESOURCE",
  PASTE_TEXT = "PASTE_TEXT",
  IMAGE = "IMAGE",
}

export interface AttachmentMention {
  readonly kind: AttachmentMentionKind;
  readonly raw: string;
  readonly value: string;
  readonly serverName?: string;
  readonly uri?: string;
}

export interface PastedTextAttachment {
  readonly kind: ResolvedAttachmentKind.PASTE_TEXT;
  readonly label: string;
  readonly text: string;
}

export interface PastedImageAttachment {
  readonly kind: ResolvedAttachmentKind.IMAGE;
  readonly label: string;
  readonly image: ImageBlock;
}

export type ExtraPromptAttachment = PastedTextAttachment | PastedImageAttachment;

export interface McpResourceReader {
  readonly readResource: (
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ) => Promise<McpReadResourceResult>;
}

export interface ResolvePromptAttachmentsParams {
  readonly prompt: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly mcpRegistry?: McpResourceReader;
  readonly projectInstructionsRuntime?: ProjectInstructionsRuntime;
  readonly extraAttachments?: readonly ExtraPromptAttachment[];
}

export interface ResolvedPromptAttachment {
  readonly kind: ResolvedAttachmentKind;
  readonly label: string;
  readonly text?: string;
  readonly image?: ImageBlock;
  readonly path?: string;
  readonly referencedFilePaths: readonly string[];
  readonly truncated: boolean;
}

export interface ResolvedPromptAttachments {
  readonly prompt: string;
  readonly content: NovaMessage["content"];
  readonly attachments: readonly ResolvedPromptAttachment[];
  readonly warnings: readonly string[];
  readonly activatedRules: readonly ProjectRuleActivation[];
}
