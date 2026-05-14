/**
 * TodoWriteTool（name: "TodoWrite"）—— 管理当前会话的结构化任务清单。
 *
 * 对齐 claude-code/src/tools/TodoWriteTool/TodoWriteTool.ts 的核心语义：模型传入
 * 完整 todo list，工具以新 list 替换内存状态；全部 completed 时清空存储。
 */

import type { Tool } from "../../Tool.ts";
import { TODO_WRITE_TOOL_NAME } from "./constants.ts";
import { TODO_WRITE_DESCRIPTION } from "./prompt.ts";
import { renderTodoList } from "./renderTodoList.ts";
import { updateTodoState } from "./todoState.ts";
import { parseTodoWriteInput, TodoStatusEnum } from "./todoTypes.ts";

export const TodoWriteTool: Tool = {
  name: TODO_WRITE_TOOL_NAME,
  description: TODO_WRITE_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete updated todo list for the current session.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Imperative form of the task, e.g. 'Run tests'.",
            },
            status: {
              type: "string",
              enum: [TodoStatusEnum.PENDING, TodoStatusEnum.IN_PROGRESS, TodoStatusEnum.COMPLETED],
              description: "Current task status.",
            },
            activeForm: {
              type: "string",
              description: "Present continuous form, e.g. 'Running tests'.",
            },
          },
          required: ["content", "status", "activeForm"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
  },
  requiresApproval: false,
  execute: (input, _context) => {
    const todos = parseTodoWriteInput(input);
    const change = updateTodoState(todos);
    const rendered = renderTodoList(change.submittedTodos);
    if (change.allCompleted) {
      return (
        "Todos have been modified successfully. All todos are completed; " +
        "the in-memory todo list has been cleared.\n\n" +
        `Completed todos:\n${rendered}`
      );
    }
    return (
      "Todos have been modified successfully. Continue using the todo list to track progress.\n\n" +
      `Current todos:\n${rendered}`
    );
  },
};
