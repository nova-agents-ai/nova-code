/** M10 Hooks 系统的领域类型。 */

/** 当前落地的 hooks 事件子集。 */
export enum HookEventName {
  PRE_TOOL_USE = "PreToolUse",
  POST_TOOL_USE = "PostToolUse",
  INSTRUCTIONS_LOADED = "InstructionsLoaded",
}

/** M10 仅支持 command hook；prompt/http/agent 留给后续 milestone。 */
export enum HookCommandType {
  COMMAND = "command",
}

/** 单个可执行 command hook。字段名尽量对齐 claude-code settings.hooks。 */
export interface CommandHook {
  readonly type: "command";
  readonly command: string;
  /** 单 hook 超时，单位秒；不填走默认值。 */
  readonly timeout?: number;
  /** 可选工具参数细粒度过滤，例如 Bash(git *)。 */
  readonly if?: string;
  /** 当前无 TUI spinner；保留字段用于后续 UI 展示。 */
  readonly statusMessage?: string;
}

/** 某个事件下的一组 matcher → hooks。 */
export interface HookMatcher {
  readonly matcher?: string;
  readonly hooks: readonly CommandHook[];
}

/** ~/.nova-code/config.json 中的 hooks 字段。 */
export type HooksConfig = Partial<Record<HookEventName, readonly HookMatcher[]>>;

interface BaseHookInput {
  readonly hook_event_name: HookEventName;
  readonly session_id: string;
  readonly cwd: string;
}

export type InstructionsLoadReason =
  | "session_start"
  | "nested_traversal"
  | "path_glob_match"
  | "include"
  | "compact";

export type InstructionsMemoryType = "Managed" | "User" | "Project" | "Local";

/** PreToolUse hook stdin JSON。 */
export interface PreToolUseHookInput extends BaseHookInput {
  readonly hook_event_name: HookEventName.PRE_TOOL_USE;
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly tool_use_id: string;
}

/** PostToolUse hook stdin JSON。 */
export interface PostToolUseHookInput extends BaseHookInput {
  readonly hook_event_name: HookEventName.POST_TOOL_USE;
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly tool_use_id: string;
  readonly tool_response: string;
  readonly is_error: boolean;
}

/** InstructionsLoaded hook stdin JSON。 */
export interface InstructionsLoadedHookInput extends BaseHookInput {
  readonly hook_event_name: HookEventName.INSTRUCTIONS_LOADED;
  readonly file_path: string;
  readonly memory_type: InstructionsMemoryType;
  readonly load_reason: InstructionsLoadReason;
  readonly globs?: readonly string[];
  readonly trigger_file_path?: string;
  readonly parent_file_path?: string;
}

/** executeHookBatch 可接收的事件输入。 */
export type HookInput = PreToolUseHookInput | PostToolUseHookInput | InstructionsLoadedHookInput;

/** command hook 的最终执行状态。 */
export enum HookExecutionOutcome {
  SUCCESS = "success",
  BLOCKING = "blocking",
  NON_BLOCKING_ERROR = "non_blocking_error",
  CANCELLED = "cancelled",
}

/** 单个 hook 执行记录，用于 AgentEvent/debug/UI。 */
export interface HookExecutionRecord {
  readonly hookEventName: HookEventName;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly command: string;
  readonly outcome: HookExecutionOutcome;
  readonly exitCode: number | undefined;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Hook 阻断信息。 */
export interface HookBlock {
  readonly reason: string;
  readonly command: string;
}

/** 一批 hooks 的聚合结果。 */
export interface HookBatchResult {
  readonly records: readonly HookExecutionRecord[];
  readonly blocked?: HookBlock;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedOutput?: string;
  readonly additionalContexts: readonly string[];
}

export type HookPermissionDecision = "allow" | "deny" | "ask";

export interface PreToolUseHookSpecificOutput {
  readonly hookEventName: HookEventName.PRE_TOOL_USE;
  readonly permissionDecision?: HookPermissionDecision;
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly additionalContext?: string;
}

export interface PostToolUseHookSpecificOutput {
  readonly hookEventName: HookEventName.POST_TOOL_USE;
  readonly additionalContext?: string;
  /** nova-code M10 小扩展：允许 PostToolUse 显式替换发回模型的工具结果。 */
  readonly updatedOutput?: string;
}

export type HookSpecificOutput = PreToolUseHookSpecificOutput | PostToolUseHookSpecificOutput;

/** command hook stdout JSON 协议的同步子集。 */
export interface HookJsonOutput {
  readonly continue?: boolean;
  readonly suppressOutput?: boolean;
  readonly stopReason?: string;
  readonly decision?: "approve" | "block";
  readonly reason?: string;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: HookSpecificOutput;
}
