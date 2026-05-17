/** Hook batch execution and stdout JSON protocol interpretation. */

import { execCommandHook } from "./execCommandHook.ts";
import { getMatchingCommandHooks } from "./matcher.ts";
import {
  type CommandHook,
  type HookBatchResult,
  type HookBlock,
  HookEventName,
  HookExecutionOutcome,
  type HookExecutionRecord,
  type HookInput,
  type HookJsonOutput,
  type HookSpecificOutput,
  type HooksConfig,
  type PostToolUseHookSpecificOutput,
  type PreToolUseHookSpecificOutput,
} from "./types.ts";

export async function executeHookBatch(params: {
  readonly config: HooksConfig | undefined;
  readonly event: HookEventName;
  readonly input: HookInput;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<HookBatchResult> {
  const hooks = getMatchingCommandHooks(params.config, params.event, params.input);
  const records: HookExecutionRecord[] = [];
  const additionalContexts: string[] = [];
  let updatedInput: Readonly<Record<string, unknown>> | undefined;
  let updatedOutput: string | undefined;

  for (const hook of hooks) {
    const interpreted = await executeAndInterpretHook({ ...params, hook });
    records.push(interpreted.record);
    if (interpreted.additionalContext !== undefined) {
      additionalContexts.push(interpreted.additionalContext);
    }
    if (interpreted.updatedInput !== undefined) {
      updatedInput = interpreted.updatedInput;
    }
    if (interpreted.updatedOutput !== undefined) {
      updatedOutput = interpreted.updatedOutput;
    }
    if (interpreted.blocked !== undefined) {
      return {
        records,
        blocked: interpreted.blocked,
        ...(updatedInput !== undefined ? { updatedInput } : {}),
        ...(updatedOutput !== undefined ? { updatedOutput } : {}),
        additionalContexts,
      };
    }
  }

  return {
    records,
    ...(updatedInput !== undefined ? { updatedInput } : {}),
    ...(updatedOutput !== undefined ? { updatedOutput } : {}),
    additionalContexts,
  };
}

interface InterpretedHookResult {
  readonly record: HookExecutionRecord;
  readonly blocked?: HookBlock;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedOutput?: string;
  readonly additionalContext?: string;
}

type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] };

async function executeAndInterpretHook(params: {
  readonly hook: CommandHook;
  readonly event: HookEventName;
  readonly input: HookInput;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<InterpretedHookResult> {
  const result = await execCommandHook(params);
  if (result.aborted) {
    return {
      record: makeRecord(params, result, HookExecutionOutcome.CANCELLED),
    };
  }
  if (result.exitCode === 2) {
    const reason = nonEmpty(result.stderr) ?? nonEmpty(result.stdout) ?? "blocked by hook";
    return {
      record: makeRecord(params, result, HookExecutionOutcome.BLOCKING),
      blocked: { command: params.hook.command, reason },
    };
  }
  if (result.exitCode !== 0) {
    return {
      record: makeRecord(params, result, HookExecutionOutcome.NON_BLOCKING_ERROR),
    };
  }

  const parsed = parseHookOutput(result.stdout);
  if (parsed.kind === "invalid-json") {
    return {
      record: makeRecord(
        params,
        { ...result, stderr: parsed.message, exitCode: 1 },
        HookExecutionOutcome.NON_BLOCKING_ERROR,
      ),
    };
  }
  if (parsed.kind === "plain") {
    return { record: makeRecord(params, result, HookExecutionOutcome.SUCCESS) };
  }

  const interpreted = interpretJsonOutput(parsed.output, params);
  return {
    record: makeRecord(
      params,
      result,
      interpreted.blocked !== undefined
        ? HookExecutionOutcome.BLOCKING
        : HookExecutionOutcome.SUCCESS,
    ),
    ...(interpreted.blocked !== undefined ? { blocked: interpreted.blocked } : {}),
    ...(interpreted.updatedInput !== undefined ? { updatedInput: interpreted.updatedInput } : {}),
    ...(interpreted.updatedOutput !== undefined
      ? { updatedOutput: interpreted.updatedOutput }
      : {}),
    ...(interpreted.additionalContext !== undefined
      ? { additionalContext: interpreted.additionalContext }
      : {}),
  };
}

function interpretJsonOutput(
  output: HookJsonOutput,
  params: { readonly hook: CommandHook; readonly event: HookEventName },
): Omit<InterpretedHookResult, "record"> {
  const commonBlock = getCommonBlock(output, params.hook.command);
  const specific = output.hookSpecificOutput;
  if (specific === undefined) {
    return commonBlock === undefined ? {} : { blocked: commonBlock };
  }
  if (specific.hookEventName !== params.event) {
    return {
      blocked: {
        command: params.hook.command,
        reason: `hook returned ${specific.hookEventName} output for ${params.event}`,
      },
    };
  }

  const result: MutablePartial<Omit<InterpretedHookResult, "record">> = {};
  if (commonBlock !== undefined) result.blocked = commonBlock;
  applySpecificOutput(result, specific, output, params.hook.command);
  return result;
}

function getCommonBlock(output: HookJsonOutput, command: string): HookBlock | undefined {
  if (output.continue === false) {
    return { command, reason: output.stopReason ?? output.reason ?? "blocked by hook" };
  }
  if (output.decision === "block") {
    return { command, reason: output.reason ?? "blocked by hook" };
  }
  return undefined;
}

function applySpecificOutput(
  result: MutablePartial<Omit<InterpretedHookResult, "record">>,
  specific: HookSpecificOutput,
  output: HookJsonOutput,
  command: string,
): void {
  switch (specific.hookEventName) {
    case HookEventName.PRE_TOOL_USE:
      if (specific.permissionDecision === "deny") {
        result.blocked = {
          command,
          reason: specific.permissionDecisionReason ?? output.reason ?? "blocked by hook",
        };
      }
      if (specific.updatedInput !== undefined) result.updatedInput = specific.updatedInput;
      if (specific.additionalContext !== undefined) {
        result.additionalContext = specific.additionalContext;
      }
      break;
    case HookEventName.POST_TOOL_USE:
      if (specific.updatedOutput !== undefined) result.updatedOutput = specific.updatedOutput;
      if (specific.additionalContext !== undefined) {
        result.additionalContext = specific.additionalContext;
      }
      break;
  }
}

function makeRecord(
  params: { readonly hook: CommandHook; readonly input: HookInput },
  result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | undefined;
    readonly durationMs: number;
  },
  outcome: HookExecutionOutcome,
): HookExecutionRecord {
  return {
    hookEventName: params.input.hook_event_name,
    toolUseId: params.input.tool_use_id,
    toolName: params.input.tool_name,
    command: params.hook.command,
    outcome,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

type ParsedHookOutput =
  | { readonly kind: "plain" }
  | { readonly kind: "invalid-json"; readonly message: string }
  | { readonly kind: "json"; readonly output: HookJsonOutput };

function parseHookOutput(stdout: string): ParsedHookOutput {
  const trimmed = stdout.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return { kind: "plain" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid-json", message: `Hook JSON output parse failed: ${message}` };
  }
  const output = validateHookJsonOutput(parsed);
  if (typeof output === "string") return { kind: "invalid-json", message: output };
  return { kind: "json", output };
}

function validateHookJsonOutput(value: unknown): HookJsonOutput | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Hook JSON output must be an object.";
  }
  const obj = value as Readonly<Record<string, unknown>>;
  const result: { -readonly [K in keyof HookJsonOutput]: HookJsonOutput[K] } = {};
  if (obj["continue"] !== undefined) {
    if (typeof obj["continue"] !== "boolean") return "Hook JSON output .continue must be boolean.";
    result.continue = obj["continue"];
  }
  if (obj["suppressOutput"] !== undefined) {
    if (typeof obj["suppressOutput"] !== "boolean") {
      return "Hook JSON output .suppressOutput must be boolean.";
    }
    result.suppressOutput = obj["suppressOutput"];
  }
  if (obj["stopReason"] !== undefined) {
    if (typeof obj["stopReason"] !== "string")
      return "Hook JSON output .stopReason must be string.";
    result.stopReason = obj["stopReason"];
  }
  if (obj["decision"] !== undefined) {
    if (obj["decision"] !== "approve" && obj["decision"] !== "block") {
      return "Hook JSON output .decision must be approve or block.";
    }
    result.decision = obj["decision"];
  }
  if (obj["reason"] !== undefined) {
    if (typeof obj["reason"] !== "string") return "Hook JSON output .reason must be string.";
    result.reason = obj["reason"];
  }
  if (obj["systemMessage"] !== undefined) {
    if (typeof obj["systemMessage"] !== "string") {
      return "Hook JSON output .systemMessage must be string.";
    }
    result.systemMessage = obj["systemMessage"];
  }
  if (obj["hookSpecificOutput"] !== undefined) {
    const specific = validateHookSpecificOutput(obj["hookSpecificOutput"]);
    if (typeof specific === "string") return specific;
    result.hookSpecificOutput = specific;
  }
  return result;
}

function validateHookSpecificOutput(value: unknown): HookSpecificOutput | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Hook JSON output .hookSpecificOutput must be an object.";
  }
  const obj = value as Readonly<Record<string, unknown>>;
  if (obj["hookEventName"] === HookEventName.PRE_TOOL_USE) {
    return validatePreToolSpecificOutput(obj);
  }
  if (obj["hookEventName"] === HookEventName.POST_TOOL_USE) {
    return validatePostToolSpecificOutput(obj);
  }
  return "Hook JSON output .hookSpecificOutput.hookEventName is unsupported.";
}

function validatePreToolSpecificOutput(
  obj: Readonly<Record<string, unknown>>,
): HookSpecificOutput | string {
  const result: {
    -readonly [K in keyof PreToolUseHookSpecificOutput]?: PreToolUseHookSpecificOutput[K];
  } = {
    hookEventName: HookEventName.PRE_TOOL_USE,
  };
  const decision = obj["permissionDecision"];
  if (decision !== undefined) {
    if (decision !== "allow" && decision !== "deny" && decision !== "ask") {
      return "PreToolUse permissionDecision must be allow, deny, or ask.";
    }
    result.permissionDecision = decision;
  }
  if (obj["permissionDecisionReason"] !== undefined) {
    if (typeof obj["permissionDecisionReason"] !== "string") {
      return "PreToolUse permissionDecisionReason must be string.";
    }
    result.permissionDecisionReason = obj["permissionDecisionReason"];
  }
  if (obj["updatedInput"] !== undefined) {
    if (!isPlainObject(obj["updatedInput"])) return "PreToolUse updatedInput must be object.";
    result.updatedInput = obj["updatedInput"];
  }
  if (obj["additionalContext"] !== undefined) {
    if (typeof obj["additionalContext"] !== "string") {
      return "PreToolUse additionalContext must be string.";
    }
    result.additionalContext = obj["additionalContext"];
  }
  return result as HookSpecificOutput;
}

function validatePostToolSpecificOutput(
  obj: Readonly<Record<string, unknown>>,
): HookSpecificOutput | string {
  const result: {
    -readonly [K in keyof PostToolUseHookSpecificOutput]?: PostToolUseHookSpecificOutput[K];
  } = {
    hookEventName: HookEventName.POST_TOOL_USE,
  };
  if (obj["updatedOutput"] !== undefined) {
    if (typeof obj["updatedOutput"] !== "string")
      return "PostToolUse updatedOutput must be string.";
    result.updatedOutput = obj["updatedOutput"];
  }
  if (obj["additionalContext"] !== undefined) {
    if (typeof obj["additionalContext"] !== "string") {
      return "PostToolUse additionalContext must be string.";
    }
    result.additionalContext = obj["additionalContext"];
  }
  return result as HookSpecificOutput;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
