import type { Tool } from "../../Tool.ts";
import type { PermissionMode } from "../../types/permissions.ts";
import { ENTER_PLAN_MODE_TOOL_NAME } from "./constants.ts";

export const EnterPlanModeTool: Tool = {
  name: ENTER_PLAN_MODE_TOOL_NAME,
  description:
    "Enter Plan Mode for non-trivial implementation work. In Plan Mode, use read-only exploration tools, design an approach, then call ExitPlanMode for user approval before editing files or running commands.",
  input_schema: {
    type: "object",
    properties: {},
  },
  requiresApproval: false,
  execute: (_input, context) => {
    const runtime = context.planModeRuntime;
    if (runtime === undefined) {
      throw new Error("Plan Mode runtime is not available in this execution context.");
    }
    runtime.enter({
      previousPermissionMode: getPreviousPermissionMode(context.permissionMode),
    });
    return [
      "Entered Plan Mode.",
      "",
      "Focus on read-only exploration and design. Do not run Bash, write files, edit files, install dependencies, or make any other changes.",
      "When the plan is complete, call ExitPlanMode with a concrete implementation plan for user approval.",
    ].join("\n");
  },
};

function getPreviousPermissionMode(mode: PermissionMode | undefined): PermissionMode {
  if (mode === undefined || mode === "plan") return "default";
  return mode;
}
