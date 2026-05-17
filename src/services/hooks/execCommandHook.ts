/** Execute a command hook with Bun.spawn. */

import type { CommandHook, HookInput } from "./types.ts";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const HOOK_MAX_BUFFER_BYTES = 1024 * 1024;

export interface CommandHookExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly durationMs: number;
  readonly aborted: boolean;
}

export async function execCommandHook(params: {
  readonly hook: CommandHook;
  readonly input: HookInput;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<CommandHookExecutionResult> {
  const startedAt = Date.now();
  const stdin = new TextEncoder().encode(`${JSON.stringify(params.input)}\n`);
  const proc = Bun.spawn({
    cmd: buildShellCommand(params.hook.command),
    cwd: params.cwd,
    env: buildHookEnv(params.input, params.cwd),
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    signal: params.signal,
    timeout: secondsToMilliseconds(params.hook.timeout),
    killSignal: "SIGTERM",
    maxBuffer: HOOK_MAX_BUFFER_BYTES,
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    aborted: params.signal.aborted || proc.signalCode !== null,
  };
}

function buildShellCommand(command: string): string[] {
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  const shell = process.env["SHELL"]?.trim() || "/bin/sh";
  return [shell, "-lc", command];
}

function buildHookEnv(input: HookInput, cwd: string): Record<string, string | undefined> {
  return {
    ...process.env,
    NOVA_CODE_HOOK_EVENT: input.hook_event_name,
    NOVA_CODE_PROJECT_DIR: cwd,
    NOVA_CODE_SESSION_ID: input.session_id,
  };
}

function secondsToMilliseconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.max(1, Math.round(value * 1000));
}
