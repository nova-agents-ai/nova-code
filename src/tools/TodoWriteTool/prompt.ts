import { TODO_WRITE_TOOL_NAME } from "./constants.ts";

export const TODO_WRITE_DESCRIPTION =
  "Update the todo list for the current session. Use proactively for complex multi-step coding tasks, " +
  "track exactly what is pending/in_progress/completed, and keep at most one item in_progress. " +
  "Each todo requires content (imperative form) and activeForm (present continuous form).";

export const TODO_WRITE_SYSTEM_PROMPT = `\n\n## TodoWrite guidance\n\nWhen the ${TODO_WRITE_TOOL_NAME} tool is available, use it proactively for non-trivial coding work:\n- Use it when the task has 3+ meaningful steps, spans multiple files, or the user gives multiple requirements.\n- Do not use it for a single trivial edit or purely informational answer.\n- After receiving a complex request, create a short todo list before making changes.\n- Keep at most one todo in_progress; mark items completed immediately after finishing them.\n- Each todo must include content (imperative, e.g. "Run tests") and activeForm (present continuous, e.g. "Running tests").`;
