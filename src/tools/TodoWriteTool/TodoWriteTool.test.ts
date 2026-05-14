/** M6 TodoWriteTool 单测：输入校验、状态替换、ASCII 渲染。 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutionError } from "../../errors/index.ts";
import { renderTodoList } from "./renderTodoList.ts";
import { TodoWriteTool } from "./TodoWriteTool.ts";
import { getCurrentTodos, resetTodoStateForTests } from "./todoState.ts";
import { parseTodoWriteInput, type TodoItem, TodoStatusEnum } from "./todoTypes.ts";

const context = { signal: new AbortController().signal };

function makeTodo(params: {
  readonly content: string;
  readonly status: TodoStatusEnum;
  readonly activeForm?: string;
}): TodoItem {
  return {
    content: params.content,
    status: params.status,
    activeForm: params.activeForm ?? `${params.content}ing`,
  };
}

beforeEach(() => {
  resetTodoStateForTests();
});

describe("TodoWriteTool metadata", () => {
  test("对外工具名和审批语义对齐 claude-code", () => {
    expect(TodoWriteTool.name).toBe("TodoWrite");
    expect(TodoWriteTool.requiresApproval).toBe(false);
    expect(TodoWriteTool.input_schema.required).toContain("todos");
  });
});

describe("TodoWriteTool.execute", () => {
  test("用完整 todo list 替换内存状态，并返回 ASCII 渲染", async () => {
    const result = await TodoWriteTool.execute(
      {
        todos: [
          makeTodo({ content: "Inspect project structure", status: TodoStatusEnum.COMPLETED }),
          makeTodo({
            content: "Implement changes across files",
            activeForm: "Implementing changes across files",
            status: TodoStatusEnum.IN_PROGRESS,
          }),
          makeTodo({ content: "Run verification", status: TodoStatusEnum.PENDING }),
        ],
      },
      context,
    );

    expect(result).toContain("Current todos:");
    expect(result).toContain("[x] 1. Inspect project structure");
    expect(result).toContain("[*] 2. Implementing changes across files");
    expect(result).toContain("[ ] 3. Run verification");

    const stored = getCurrentTodos();
    expect(stored).toHaveLength(3);
    expect(stored[1]?.status).toBe(TodoStatusEnum.IN_PROGRESS);
  });

  test("全部 completed 后清空内存状态，但结果仍渲染提交列表", async () => {
    await TodoWriteTool.execute(
      {
        todos: [makeTodo({ content: "Implement change", status: TodoStatusEnum.IN_PROGRESS })],
      },
      context,
    );
    expect(getCurrentTodos()).toHaveLength(1);

    const result = await TodoWriteTool.execute(
      {
        todos: [makeTodo({ content: "Implement change", status: TodoStatusEnum.COMPLETED })],
      },
      context,
    );

    expect(result).toContain("has been cleared");
    expect(result).toContain("Completed todos:");
    expect(result).toContain("[x] 1. Implement change");
    expect(getCurrentTodos()).toEqual([]);
  });

  test("空列表可显式清空为 empty 状态", async () => {
    const result = await TodoWriteTool.execute({ todos: [] }, context);

    expect(result).toContain("Current todos:");
    expect(result).toContain("Todo list is empty.");
    expect(getCurrentTodos()).toEqual([]);
  });
});

describe("parseTodoWriteInput", () => {
  test("缺少 todos 数组时报 ToolExecutionError", () => {
    expect(() => parseTodoWriteInput({})).toThrow(ToolExecutionError);
  });

  test("非法 status 报 ToolExecutionError", () => {
    expect(() =>
      parseTodoWriteInput({
        todos: [{ content: "x", status: "doing", activeForm: "Doing x" }],
      }),
    ).toThrow(ToolExecutionError);
  });

  test("同一列表最多允许一个 in_progress", () => {
    expect(() =>
      parseTodoWriteInput({
        todos: [
          { content: "a", status: "in_progress", activeForm: "Doing a" },
          { content: "b", status: "in_progress", activeForm: "Doing b" },
        ],
      }),
    ).toThrow(ToolExecutionError);
  });
});

describe("renderTodoList", () => {
  test("稳定渲染三态 todo", () => {
    expect(
      renderTodoList([
        makeTodo({ content: "Plan", status: TodoStatusEnum.PENDING }),
        makeTodo({ content: "Code", activeForm: "Coding", status: TodoStatusEnum.IN_PROGRESS }),
        makeTodo({ content: "Test", status: TodoStatusEnum.COMPLETED }),
      ]),
    ).toBe("[ ] 1. Plan\n[*] 2. Coding\n[x] 3. Test");
  });
});
