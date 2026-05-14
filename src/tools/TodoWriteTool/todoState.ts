/**
 * TodoWrite 的进程内任务表。
 *
 * nova-code M6 暂无 claude-code AppState / agentId 注入，因此采用单进程一份状态。
 * 对 chat 进程来说这等价于单会话内存表；ask 进程结束即释放。
 */

import { type TodoItem, TodoStatusEnum } from "./todoTypes.ts";

let currentTodos: readonly TodoItem[] = [];

export interface TodoWriteStateChange {
  readonly oldTodos: readonly TodoItem[];
  readonly storedTodos: readonly TodoItem[];
  /** 本次调用提交的原始 todos；即使 all completed 后清空内存，也保留给渲染。 */
  readonly submittedTodos: readonly TodoItem[];
  readonly allCompleted: boolean;
}

/** 用新的 todo list 替换当前内存表；全部完成时自动清空。 */
export function updateTodoState(todos: readonly TodoItem[]): TodoWriteStateChange {
  const oldTodos = currentTodos;
  const allCompleted =
    todos.length > 0 && todos.every((todo) => todo.status === TodoStatusEnum.COMPLETED);
  currentTodos = allCompleted ? [] : [...todos];
  return {
    oldTodos,
    storedTodos: currentTodos,
    submittedTodos: [...todos],
    allCompleted,
  };
}

/** 读取当前内存表快照。 */
export function getCurrentTodos(): readonly TodoItem[] {
  return [...currentTodos];
}

/** 测试用：重置模块级状态。 */
export function resetTodoStateForTests(): void {
  currentTodos = [];
}
