import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHookBatch, getMatchingCommandHooks } from "./index.ts";
import {
  HookCommandType,
  HookEventName,
  HookExecutionOutcome,
  type HookInput,
  type HooksConfig,
} from "./types.ts";

async function makeTempDir(): Promise<{
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-hooks-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makePreInput(
  input: Readonly<Record<string, unknown>> = { message: "original" },
): HookInput {
  return {
    hook_event_name: HookEventName.PRE_TOOL_USE,
    session_id: "test-session",
    cwd: "/tmp/nova-hooks",
    tool_name: "echo",
    tool_input: input,
    tool_use_id: "toolu_1",
  };
}

describe("hooks matcher", () => {
  test("matches exact, pipe, wildcard and if condition", () => {
    const config: HooksConfig = {
      PreToolUse: [
        {
          matcher: "Bash|echo",
          hooks: [
            { type: HookCommandType.COMMAND, command: "echo matched" },
            { type: HookCommandType.COMMAND, command: "echo skipped", if: "Bash(git *)" },
          ],
        },
        {
          matcher: "*",
          hooks: [{ type: HookCommandType.COMMAND, command: "echo all" }],
        },
      ],
    };

    const hooks = getMatchingCommandHooks(config, HookEventName.PRE_TOOL_USE, makePreInput());

    expect(hooks.map((hook) => hook.command)).toEqual(["echo matched", "echo all"]);
  });
});

describe("executeHookBatch", () => {
  test("PreToolUse hook can update tool input via JSON stdout", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scriptPath = join(dir, "pre-update.ts");
      await Bun.write(
        scriptPath,
        `const input = await new Response(Bun.stdin.stream()).json();
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: { message: input.tool_input.message + "-hooked" }
  }
}));
`,
      );
      const result = await executeHookBatch({
        config: {
          PreToolUse: [
            {
              matcher: "echo",
              hooks: [{ type: HookCommandType.COMMAND, command: `bun run ${scriptPath}` }],
            },
          ],
        },
        event: HookEventName.PRE_TOOL_USE,
        input: makePreInput(),
        cwd: dir,
        signal: new AbortController().signal,
      });

      expect(result.blocked).toBeUndefined();
      expect(result.updatedInput).toEqual({ message: "original-hooked" });
      expect(result.records[0]?.outcome).toBe(HookExecutionOutcome.SUCCESS);
    } finally {
      await cleanup();
    }
  });

  test("exit code 2 blocks tool execution", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scriptPath = join(dir, "pre-block.ts");
      await Bun.write(scriptPath, `console.error("blocked by policy"); process.exit(2);\n`);

      const result = await executeHookBatch({
        config: {
          PreToolUse: [
            {
              matcher: "echo",
              hooks: [{ type: HookCommandType.COMMAND, command: `bun run ${scriptPath}` }],
            },
          ],
        },
        event: HookEventName.PRE_TOOL_USE,
        input: makePreInput(),
        cwd: dir,
        signal: new AbortController().signal,
      });

      expect(result.blocked?.reason).toContain("blocked by policy");
      expect(result.records[0]?.outcome).toBe(HookExecutionOutcome.BLOCKING);
    } finally {
      await cleanup();
    }
  });

  test("PostToolUse hook can replace tool output", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scriptPath = join(dir, "post-update.ts");
      await Bun.write(
        scriptPath,
        `const input = await new Response(Bun.stdin.stream()).json();
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    updatedOutput: "wrapped:" + input.tool_response
  }
}));
`,
      );

      const result = await executeHookBatch({
        config: {
          PostToolUse: [
            {
              matcher: "echo",
              hooks: [{ type: HookCommandType.COMMAND, command: `bun run ${scriptPath}` }],
            },
          ],
        },
        event: HookEventName.POST_TOOL_USE,
        input: {
          hook_event_name: HookEventName.POST_TOOL_USE,
          session_id: "test-session",
          cwd: dir,
          tool_name: "echo",
          tool_input: { message: "x" },
          tool_use_id: "toolu_1",
          tool_response: "echo: x",
          is_error: false,
        },
        cwd: dir,
        signal: new AbortController().signal,
      });

      expect(result.updatedOutput).toBe("wrapped:echo: x");
    } finally {
      await cleanup();
    }
  });
});
