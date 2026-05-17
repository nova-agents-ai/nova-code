/** Hooks config runtime validation. */

import { ConfigError } from "../../errors/index.ts";
import {
  type CommandHook,
  HookCommandType,
  HookEventName,
  type HookMatcher,
  type HooksConfig,
} from "./types.ts";

const SUPPORTED_HOOK_EVENTS = [HookEventName.PRE_TOOL_USE, HookEventName.POST_TOOL_USE] as const;

/** Validate unknown JSON into the M10 HooksConfig shape. */
export function validateHooksConfig(value: unknown, path: string): HooksConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${path}.hooks must be an object, got ${typeName(value)}.`);
  }

  const raw = value as Readonly<Record<string, unknown>>;
  const result: { -readonly [K in HookEventName]?: readonly HookMatcher[] } = {};
  for (const [eventName, eventValue] of Object.entries(raw)) {
    const event = parseHookEventName(eventName, path);
    result[event] = validateHookMatchers(eventValue, `${path}.hooks.${event}`);
  }
  return result;
}

function parseHookEventName(value: string, path: string): HookEventName {
  for (const event of SUPPORTED_HOOK_EVENTS) {
    if (event === value) return event;
  }
  throw new ConfigError(
    `${path}.hooks has unsupported event '${value}'. Supported events: ${SUPPORTED_HOOK_EVENTS.join(
      ", ",
    )}.`,
  );
}

function validateHookMatchers(value: unknown, field: string): readonly HookMatcher[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be an array, got ${typeName(value)}.`);
  }
  return value.map((item, index) => validateHookMatcher(item, `${field}[${index}]`));
}

function validateHookMatcher(value: unknown, field: string): HookMatcher {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object, got ${typeName(value)}.`);
  }
  const obj = value as Readonly<Record<string, unknown>>;
  const hooks = validateCommandHooks(obj["hooks"], `${field}.hooks`);
  if (obj["matcher"] === undefined) return { hooks };
  return {
    matcher: validateNonEmptyString(obj["matcher"], `${field}.matcher`),
    hooks,
  };
}

function validateCommandHooks(value: unknown, field: string): readonly CommandHook[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be an array, got ${typeName(value)}.`);
  }
  return value.map((item, index) => validateCommandHook(item, `${field}[${index}]`));
}

function validateCommandHook(value: unknown, field: string): CommandHook {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object, got ${typeName(value)}.`);
  }
  const obj = value as Readonly<Record<string, unknown>>;
  const type = obj["type"];
  if (type !== HookCommandType.COMMAND) {
    throw new ConfigError(`${field}.type must be "command", got ${String(type)}.`);
  }

  const result: { -readonly [K in keyof CommandHook]: CommandHook[K] } = {
    type: HookCommandType.COMMAND,
    command: validateNonEmptyString(obj["command"], `${field}.command`),
  };
  if (obj["timeout"] !== undefined) {
    result.timeout = validatePositiveNumber(obj["timeout"], `${field}.timeout`);
  }
  if (obj["if"] !== undefined) {
    result.if = validateNonEmptyString(obj["if"], `${field}.if`);
  }
  if (obj["statusMessage"] !== undefined) {
    result.statusMessage = validateNonEmptyString(obj["statusMessage"], `${field}.statusMessage`);
  }
  return result;
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string, got ${typeName(value)}.`);
  }
  return value;
}

function validatePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${field} must be a positive number, got ${String(value)}.`);
  }
  return value;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
