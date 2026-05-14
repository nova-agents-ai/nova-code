/** TodoWrite 的领域类型与输入校验。 */

import { ToolExecutionError } from "../../errors/index.ts";
import { describeType } from "../utils.ts";
import { TODO_WRITE_TOOL_NAME } from "./constants.ts";

export enum TodoStatusEnum {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
}

export interface TodoItem {
  /** Imperative form, e.g. "Run tests". */
  readonly content: string;
  readonly status: TodoStatusEnum;
  /** Present continuous form, e.g. "Running tests". */
  readonly activeForm: string;
}

/** 解析并校验 TodoWrite input。 */
export function parseTodoWriteInput(input: Readonly<Record<string, unknown>>): readonly TodoItem[] {
  const rawTodos = input["todos"];
  if (!Array.isArray(rawTodos)) {
    throw new ToolExecutionError(
      TODO_WRITE_TOOL_NAME,
      `Missing required array field 'todos'. Got ${describeType(rawTodos)}.`,
    );
  }
  const todos = rawTodos.map((rawTodo, index) => parseTodoItem(rawTodo, index));
  validateInProgressCount(todos);
  return todos;
}

function parseTodoItem(value: unknown, index: number): TodoItem {
  if (!isRecord(value)) {
    throw new ToolExecutionError(
      TODO_WRITE_TOOL_NAME,
      `todos[${index}] must be an object. Got ${describeType(value)}.`,
    );
  }

  return {
    content: requireNonEmptyString(value["content"], `todos[${index}].content`),
    status: parseStatus(value["status"], `todos[${index}].status`),
    activeForm: requireNonEmptyString(value["activeForm"], `todos[${index}].activeForm`),
  };
}

function parseStatus(value: unknown, field: string): TodoStatusEnum {
  if (
    value === TodoStatusEnum.PENDING ||
    value === TodoStatusEnum.IN_PROGRESS ||
    value === TodoStatusEnum.COMPLETED
  ) {
    return value;
  }
  throw new ToolExecutionError(
    TODO_WRITE_TOOL_NAME,
    `${field} must be one of pending, in_progress, completed. Got ${describeType(value)}.`,
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolExecutionError(
      TODO_WRITE_TOOL_NAME,
      `${field} must be a non-empty string. Got ${describeType(value)}.`,
    );
  }
  return value;
}

function validateInProgressCount(todos: readonly TodoItem[]): void {
  const count = todos.filter((todo) => todo.status === TodoStatusEnum.IN_PROGRESS).length;
  if (count <= 1) return;
  throw new ToolExecutionError(
    TODO_WRITE_TOOL_NAME,
    `Todo list can have at most one in_progress item. Got ${count}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
