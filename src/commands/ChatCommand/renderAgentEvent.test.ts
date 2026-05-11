/**
 * renderAgentEvent 单测 —— 覆盖 M1.5 ask 路径所有分支 + tool_call 前补换行的边界。
 */

import { describe, expect, test } from "bun:test";

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
});
