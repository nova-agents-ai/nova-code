/** TodoWrite 的 ASCII 渲染。 */

import { type TodoItem, TodoStatusEnum } from "./todoTypes.ts";

/** 把 todo list 渲染成稳定、可读、适合 stderr/tool_result 的 ASCII 文本。 */
export function renderTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "Todo list is empty.";
  return todos.map((todo, index) => renderTodoLine(todo, index)).join("\n");
}

function renderTodoLine(todo: TodoItem, index: number): string {
  const number = index + 1;
  switch (todo.status) {
    case TodoStatusEnum.PENDING:
      return `[ ] ${number}. ${todo.content}`;
    case TodoStatusEnum.IN_PROGRESS:
      return `[*] ${number}. ${todo.activeForm}`;
    case TodoStatusEnum.COMPLETED:
      return `[x] ${number}. ${todo.content}`;
  }
}
