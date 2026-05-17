/**
 * renderAgentEvent 单测 —— 覆盖 M1.5 ask 路径所有分支 + tool_call 前补换行的边界。
 */

import { describe, expect, test } from "bun:test";

import { HookEventName, HookExecutionOutcome } from "../../services/hooks/types.ts";
import { type AgentEvent, AgentStopReasonEnum, MessageRoleEnum } from "../../types/message.ts";
import {
  createRenderState,
  type RenderState,
  type ReplIO,
  renderAgentEvent,
} from "./renderAgentEvent.ts";

/** 构造一个记录型 ReplIO，断言时直接检查字符串数组。 */
function makeIO(): { io: ReplIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: ReplIO = {
    stdout(text) {
      out.push(text);
    },
    stderr(text) {
      err.push(text);
    },
  };
  return { io, out, err };
}

describe("renderAgentEvent", () => {
  test("turn_start turn=1 不输出任何内容", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent({ type: "turn_start", turn: 1 }, io, state);

    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(state.inAssistantText).toBe(false);
  });

  test("turn_start turn>1 在 stderr 打一个换行", () => {
    const { io, out, err } = makeIO();
    const state: RenderState = createRenderState();

    renderAgentEvent({ type: "turn_start", turn: 2 }, io, state);

    expect(out).toEqual([]);
    expect(err).toEqual(["\n"]);
  });

  test("text_delta 直接写 stdout 并把 inAssistantText 置 true", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();
    expect(state.inAssistantText).toBe(false);

    renderAgentEvent({ type: "text_delta", delta: "Hello " }, io, state);
    renderAgentEvent({ type: "text_delta", delta: "world" }, io, state);

    expect(out).toEqual(["Hello ", "world"]);
    expect(err).toEqual([]);
    expect(state.inAssistantText).toBe(true);
  });

  test("tool_call：无正文在前 → 仅 stderr 打 [tool] 行", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();
    const event: AgentEvent = {
      type: "tool_call",
      toolUseId: "tu_1",
      toolName: "bash",
      input: { cmd: "ls" },
    };

    renderAgentEvent(event, io, state);

    expect(out).toEqual([]);
    expect(err).toEqual(['\n[tool] bash {"cmd":"ls"}\n']);
    expect(state.inAssistantText).toBe(false);
  });

  test("tool_call：前面刚写过正文 → 先 stdout 补 \\n，再 stderr 打 [tool] 行，state 重置", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent({ type: "text_delta", delta: "Let me run: " }, io, state);
    expect(state.inAssistantText).toBe(true);

    renderAgentEvent(
      {
        type: "tool_call",
        toolUseId: "tu_1",
        toolName: "grep",
        input: { pattern: "TODO" },
      },
      io,
      state,
    );

    expect(out).toEqual(["Let me run: ", "\n"]);
    expect(err).toEqual(['\n[tool] grep {"pattern":"TODO"}\n']);
    expect(state.inAssistantText).toBe(false);
  });

  test("tool_result：isError=false 时静默（不打扰用户）", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "tool_result",
        toolUseId: "tu_1",
        toolName: "bash",
        content: "total 0",
        isError: false,
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("tool_result：TodoWrite 成功时展示 ASCII 任务表", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "tool_result",
        toolUseId: "tu_1",
        toolName: "TodoWrite",
        content: "Current todos:\n[*] 1. Implementing changes",
        isError: false,
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual(["Current todos:\n[*] 1. Implementing changes\n"]);
  });

  test("tool_result：isError=true 时 stderr 打一行简短错误", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "tool_result",
        toolUseId: "tu_1",
        toolName: "bash",
        content: "permission denied",
        isError: true,
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual(["[tool] bash failed: permission denied\n"]);
  });

  test("done：stdout 补换行并重置 inAssistantText", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();
    state.inAssistantText = true;

    renderAgentEvent(
      { type: "done", turns: 1, finalMessage: { role: MessageRoleEnum.ASSISTANT, content: "x" } },
      io,
      state,
    );

    expect(out).toEqual(["\n"]);
    expect(err).toEqual([]);
    expect(state.inAssistantText).toBe(false);
  });

  test("turn_end 事件不产生任何 IO", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "turn_end",
        turn: 1,
        message: { role: MessageRoleEnum.ASSISTANT, content: "x" },
        stopReason: AgentStopReasonEnum.END_TURN,
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("一整轮事件序列：turn_start → text_delta → tool_call → text_delta → done", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent({ type: "turn_start", turn: 1 }, io, state);
    renderAgentEvent({ type: "text_delta", delta: "计划：" }, io, state);
    renderAgentEvent(
      { type: "tool_call", toolUseId: "tu_1", toolName: "ls", input: {} },
      io,
      state,
    );
    renderAgentEvent({ type: "text_delta", delta: "结果如上" }, io, state);
    renderAgentEvent(
      { type: "done", turns: 1, finalMessage: { role: MessageRoleEnum.ASSISTANT, content: "x" } },
      io,
      state,
    );

    // stdout：正文、补 \n、第二段正文、末尾 \n
    expect(out).toEqual(["计划：", "\n", "结果如上", "\n"]);
    // stderr：[tool] 行
    expect(err).toEqual(["\n[tool] ls {}\n"]);
  });

  // ------------------------------------------------------------------------
  // M3 权限事件
  // ------------------------------------------------------------------------

  test("permission_request 在 stderr 打提示；stdout 不动", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "permission_request",
        toolUseId: "tu_1",
        toolName: "Bash",
        input: { command: "git push" },
        reason: "tool requires approval",
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual(["[permission] asking: Bash (tool requires approval)\n"]);
  });

  test("permission_request 在正文后触发 → 先补 stdout \\n 再打提示", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent({ type: "text_delta", delta: "正在通知..." }, io, state);
    renderAgentEvent(
      {
        type: "permission_request",
        toolUseId: "tu_1",
        toolName: "FileWrite",
        input: { path: "a.ts" },
        reason: "tool requires approval",
      },
      io,
      state,
    );

    expect(out).toEqual(["正在通知...", "\n"]);
    expect(err).toEqual(["[permission] asking: FileWrite (tool requires approval)\n"]);
    expect(state.inAssistantText).toBe(false);
  });

  test("permission_decision: allow 且无 persisted → 不输出噪点", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "permission_decision",
        toolUseId: "tu_1",
        toolName: "Bash",
        decision: "allow",
        reason: "matched by session allow rule",
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("permission_decision: deny → stderr 一行", () => {
    const { io, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "permission_decision",
        toolUseId: "tu_1",
        toolName: "Bash",
        decision: "deny",
        reason: "blocked by built-in DENY pattern: rm-rf-root",
      },
      io,
      state,
    );

    expect(err).toEqual([
      "[permission] denied: Bash (blocked by built-in DENY pattern: rm-rf-root)\n",
    ]);
  });

  test("permission_decision: allow + persisted=session → stderr 提示已保存", () => {
    const { io, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "permission_decision",
        toolUseId: "tu_1",
        toolName: "Bash",
        decision: "allow",
        reason: "user chose allow-always-session",
        persisted: "session",
      },
      io,
      state,
    );

    expect(err).toEqual(["[permission] allowed & saved to session: Bash\n"]);
  });

  // ── M10 hook 事件渲染 ─────────────────────────────────────────────────
  test("hook_result: success 默认静默", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "hook_result",
        hookEventName: HookEventName.PRE_TOOL_USE,
        toolUseId: "tu_1",
        toolName: "Bash",
        command: "bun run hooks/pre.ts",
        outcome: HookExecutionOutcome.SUCCESS,
        exitCode: 0,
        durationMs: 12,
        stdout: "",
        stderr: "",
      },
      io,
      state,
    );

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("hook_result: blocking / warning / cancelled 会输出 stderr", () => {
    const { io, err } = makeIO();
    const state = createRenderState();

    renderAgentEvent(
      {
        type: "hook_result",
        hookEventName: HookEventName.PRE_TOOL_USE,
        toolUseId: "tu_1",
        toolName: "Bash",
        command: "bun run hooks/pre.ts",
        outcome: HookExecutionOutcome.BLOCKING,
        exitCode: 2,
        durationMs: 12,
        stdout: "",
        stderr: "blocked by policy\nsecond line",
      },
      io,
      state,
    );
    renderAgentEvent(
      {
        type: "hook_result",
        hookEventName: HookEventName.POST_TOOL_USE,
        toolUseId: "tu_1",
        toolName: "Bash",
        command: "bun run hooks/post.ts",
        outcome: HookExecutionOutcome.NON_BLOCKING_ERROR,
        exitCode: 1,
        durationMs: 12,
        stdout: "plain stdout",
        stderr: "",
      },
      io,
      state,
    );
    renderAgentEvent(
      {
        type: "hook_result",
        hookEventName: HookEventName.POST_TOOL_USE,
        toolUseId: "tu_1",
        toolName: "Bash",
        command: "bun run hooks/post.ts",
        outcome: HookExecutionOutcome.CANCELLED,
        exitCode: undefined,
        durationMs: 12,
        stdout: "",
        stderr: "",
      },
      io,
      state,
    );

    expect(err.join("")).toContain("[hook] PreToolUse:Bash blocked");
    expect(err.join("")).toContain("blocked by policy");
    expect(err.join("")).toContain("[hook] PostToolUse:Bash warning");
    expect(err.join("")).toContain("plain stdout");
    expect(err.join("")).toContain("[hook] PostToolUse:Bash cancelled");
  });

  // ── M4 compact 事件渲染 ────────────────────────────────────────────────
  test("compact_start: auto trigger 打印 auto-compacting", () => {
    const { io, err } = makeIO();
    const state = createRenderState();
    renderAgentEvent(
      { type: "compact_start", trigger: "auto", preCompactTokenCount: 168000 },
      io,
      state,
    );
    expect(err.join("")).toContain("[compact] auto-compacting");
    expect(err.join("")).toContain("168000");
  });

  test("compact_start: manual trigger 不打 auto- 前缀", () => {
    const { io, err } = makeIO();
    const state = createRenderState();
    renderAgentEvent(
      { type: "compact_start", trigger: "manual", preCompactTokenCount: 100 },
      io,
      state,
    );
    expect(err.join("")).toContain("[compact] compacting");
    expect(err.join("")).not.toContain("auto-");
  });

  test("compact_end: 成功打 X → Y tokens", () => {
    const { io, err } = makeIO();
    const state = createRenderState();
    renderAgentEvent(
      {
        type: "compact_end",
        trigger: "auto",
        preCompactTokenCount: 170000,
        postCompactTokenCount: 800,
      },
      io,
      state,
    );
    expect(err.join("")).toContain("[compact] done: 170000 → 800");
  });

  test("compact_end: 失败打 [compact] failed", () => {
    const { io, err } = makeIO();
    const state = createRenderState();
    renderAgentEvent(
      {
        type: "compact_end",
        trigger: "auto",
        preCompactTokenCount: 170000,
        error: "API rate-limited",
      },
      io,
      state,
    );
    expect(err.join("")).toContain("[compact] failed: API rate-limited");
  });

  test("compact_start: 若处于 inAssistantText → 先补 stdout 换行", () => {
    const { io, out, err } = makeIO();
    const state = createRenderState();
    state.inAssistantText = true;
    renderAgentEvent(
      { type: "compact_start", trigger: "auto", preCompactTokenCount: 100 },
      io,
      state,
    );
    expect(out).toEqual(["\n"]);
    expect(err.join("")).toContain("[compact]");
    expect(state.inAssistantText).toBe(false);
  });
});
