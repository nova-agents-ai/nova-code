/**
 * 纯函数事件渲染 —— 把 AgentEvent 流转成用户可见的 I/O 输出。
 *
 * 对齐设计稿 §5：ask / chat 两个入口共享同一套渲染逻辑，避免重复 switch。
 *
 * 为什么显式把 ReplIO 当参数注入（而非直接写 process.stdout）：
 * 1. 单测可以用假 io 断言每条事件的输出，不必劫持 process.stdout
 * 2. e2e 下可以改写成"带前缀/带时间戳"的 io，不动核心逻辑
 *
 * RenderState 是跨事件携带的小状态（目前只有 inAssistantText）：
 *   - 遇到 text_delta 时置 true，遇到 tool_call 时若 true 先补一个换行再落盘
 *     [tool] 行，避免"Assistant 正文紧贴 [tool]"的视觉拥挤
 *   - 下一个 turn_end 或 done 都不会自动重置——由 tool_call 分支主动重置即可
 *     覆盖 claude-code 风格的"一次 turn 内先文字后工具"的常见序列
 */

import type { AgentEvent } from "../../types/message.ts";

/** REPL 与事件渲染之间的 I/O 抽象。 */
export interface ReplIO {
  /** 写"答案"（模型输出正文）；生产路径对应 process.stdout。 */
  stdout(text: string): void;
  /** 写"辅助信息"（工具调用提示、错误、分隔换行）；生产路径对应 process.stderr。 */
  stderr(text: string): void;
}

/** 跨事件携带的渲染状态。 */
export interface RenderState {
  /** 当前轮次内是否已经写过模型正文；用于在 tool_call 前补换行。 */
  inAssistantText: boolean;
}

/** 构造一份初始化的 RenderState，便于调用方在每轮 sendTurn 前复用。 */
export function createRenderState(): RenderState {
  return { inAssistantText: false };
}

/**
 * 把一条 AgentEvent 渲染到 io，并按需更新 state。
 *
 * 行为对齐 M1.5 ask 路径（runAskWithLLM 的 switch 分支），两处共享本函数。
 */
export function renderAgentEvent(event: AgentEvent, io: ReplIO, state: RenderState): void {
  switch (event.type) {
    case "turn_start":
      // 第二轮起，在工具调用之后插入空行，把"工具输出区"与"下一段正文"分开
      if (event.turn > 1) {
        io.stderr("\n");
      }
      break;
    case "text_delta":
      io.stdout(event.delta);
      state.inAssistantText = true;
      break;
    case "tool_call":
      // 如果前面刚写过正文（未以换行结尾），先补换行避免 [tool] 行挤在正文末尾
      if (state.inAssistantText) {
        io.stdout("\n");
        state.inAssistantText = false;
      }
      io.stderr(`\n[tool] ${event.toolName} ${JSON.stringify(event.input)}\n`);
      break;
    case "tool_result":
      // 工具失败：只在 stderr 打一行简短错误，不把整块 content 塞给用户
      if (event.isError) {
        io.stderr(`[tool] ${event.toolName} failed: ${event.content}\n`);
      }
      break;
    case "done":
      // 末尾补一个换行，让 shell 提示符（或下一轮 prompt）另起一行
      io.stdout("\n");
      state.inAssistantText = false;
      break;
    // turn_end 不直接展示；完整 assistant message 已在 debug sink / session 内
    case "turn_end":
      break;
    case "permission_request":
      // M3：将询问用户。在 stderr 打一行提示（具体交互由 PermissionProvider 接管，
      // 本渲染器不阻塞）。如果前面刚写过正文，先补换行避免拥挤。
      if (state.inAssistantText) {
        io.stdout("\n");
        state.inAssistantText = false;
      }
      io.stderr(`[permission] asking: ${event.toolName} (${event.reason})\n`);
      break;
    case "permission_decision":
      // M3：决策落定。allow 正常走不用増加噪点；deny / ask-after-deny 打一行。
      if (event.decision === "deny") {
        io.stderr(`[permission] denied: ${event.toolName} (${event.reason})\n`);
      } else if (event.persisted !== undefined) {
        io.stderr(`[permission] allowed & saved to ${event.persisted}: ${event.toolName}\n`);
      }
      break;
  }
}
