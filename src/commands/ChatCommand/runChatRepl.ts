/**
 * runChatRepl —— Chat 子命令的 REPL 主循环。
 *
 * 职责（对齐设计稿 §8、§9）：
 *   1. 用 node:readline/promises 读取用户每一行输入
 *   2. 斜杠命令先过 dispatcher；非斜杠调 session.sendTurn
 *   3. 事件流 → debugSink + renderAgentEvent
 *   4. SIGINT 状态机：streaming 阶段取消；idle 阶段双按 1.5s 退出
 *
 * 依赖注入点（均为测试友好，不强制使用）：
 *   - input/output：默认 process.stdin/process.stdout，可注入替换
 *   - confirm：默认走 readline 问 y/n，/load 弹确认时用
 *
 * 为什么 REPL 不单测：
 *   - readline 与 TTY/SIGINT 的交互靠子进程 e2e 覆盖（Task 10）
 *   - 本文件内部纯控制流、无领域逻辑；拆出更多测试只会重复 dispatcher/session/render
 *     各自已有的断言
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";

import type { ConfigSource, ResolvedConfig } from "../../config/config.ts";
import { AbortError } from "../../errors/index.ts";
import { buildSystemPrompt } from "../../QueryEngine.ts";
import {
  type AutoCompactTrackingState,
  createAutoCompactTrackingState,
} from "../../services/compact/autoCompact.ts";
import { type CostTracker, formatChatCostSummary } from "../../services/cost/index.ts";
import type { PermissionStore } from "../../services/permissions/permissionStore.ts";
import type { Tool } from "../../Tool.ts";
import type { AgentEvent, ApiUsage } from "../../types/message.ts";
import type { PermissionMode } from "../../types/permissions.ts";
import type { DebugSink } from "../AskCommand/debugSink.ts";
import type { ChatSession } from "./ChatSession.ts";
import { createRenderState, type ReplIO, renderAgentEvent } from "./renderAgentEvent.ts";
import { createReplPermissionProvider } from "./replPermissionProvider.ts";
import { dispatchSlash } from "./slash/dispatcher.ts";
import type { PermissionModeRef, SlashIO } from "./slash/types.ts";

/** runChatRepl 的参数。 */
export interface RunChatReplParams {
  readonly session: ChatSession;
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  /** Optional dynamic tool source, used by MCP list_changed refreshes between turns. */
  readonly getTools?: () => readonly Tool[];
  readonly debugSink: DebugSink;
  /**
   * 可选：记录原始 LLM 请求/响应的独立 sink（chat-llm-*.log）。
   * 未开 debug 时由 ChatCommand 传入 NULL sink 或 undefined；rEPL 原样下发到 sendTurn。
   */
  readonly llmLogSink?: DebugSink;
  /** 给 /save /load 注入 home 目录等（测试用）。 */
  readonly configSource?: ConfigSource;
  /**
   * 可选：自定义 I/O。默认包 process.stdout/stderr。
   * 注入它就等价于接管所有用户可见输出。
   */
  readonly io?: ReplIO;
  /**
   * 可选：权限规则存储。注入后会一并传给 sendTurn，让 QueryEngine 走
   * permissionEngine 的七步流水线。未注入则等价于旧版全放行。
   */
  readonly permissionStore?: PermissionStore;
  /** 可选：权限模式，默认 "default"。 */
  readonly permissionMode?: PermissionMode;
  /**
   * M4：CLAUDE.md 4 层加载结果，启动时一次性加载。注入后追加到 system prompt 末尾。
   * 不注入 = 不启用 CLAUDE.md。
   */
  readonly projectInstructions?: string;
  /** M4：是否启用自动 compact，默认 true。配合 autoCompactTracking 才生效。 */
  readonly autoCompactEnabled?: boolean;
  /** M4：自动 compact tracking；不注入则 runChatRepl 自动构造一份。 */
  readonly autoCompactTracking?: AutoCompactTrackingState;
  /** M5：会话级 cost tracker；不注入则不打印/不累计费用。 */
  readonly costTracker?: CostTracker;
}

/**
 * SIGINT 状态机：
 * - "idle"：等待用户输入或空闲。
 * - "streaming"：正在跑一轮 agent loop；Ctrl+C → 调 abortController.abort()
 * - "pending-exit"：idle 下首次 Ctrl+C，进入 1.5s 待确认窗口；二次按下即退出
 */
type SigintPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "streaming"; readonly abort: AbortController }
  | { readonly kind: "pending-exit"; readonly timer: ReturnType<typeof setTimeout> };

/** Ctrl+C 双按窗口的长度（ms）。和设计稿 §8 保持一致。 */
const PENDING_EXIT_WINDOW_MS = 1500;

/**
 * 入口函数。返回值是最终进程退出码：
 *  - 0：用户 /exit 或 EOF 正常退出
 *  - 130：Ctrl+C 双按退出
 *  - 2：顶层未处理异常（调用方可选择忽略，此处只做防御性兜底）
 */
export async function runChatRepl(params: RunChatReplParams): Promise<number> {
  const {
    session,
    config,
    tools,
    getTools,
    debugSink,
    llmLogSink,
    configSource,
    permissionStore,
    permissionMode,
    projectInstructions,
    costTracker,
  } = params;
  // M4: 自动 compact 默认开启；调用方可通过 autoCompactEnabled=false 关闭
  const autoCompactEnabled = params.autoCompactEnabled !== false;
  // M4: 单 chat 会话共用一份 tracking（若调用方注入则用注入的）
  const autoCompactTracking: AutoCompactTrackingState =
    params.autoCompactTracking ?? createAutoCompactTrackingState();
  const readCurrentTools = (): readonly Tool[] => getTools?.() ?? tools;

  // ────────────── I/O wiring ──────────────
  const io: ReplIO = params.io ?? defaultReplIO();
  const rl: ReadlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    // terminal=true 才有上下键历史；非 TTY（比如 pipe）下 readline 会关闭这些增强
    terminal: process.stdin.isTTY === true,
  });

  // 使用 async iterator 而非 rl.question()：readline/promises 的 question 基于
  // `once("line")`，在 stdin 开头就已缓冲好多行的场景（e.g. 子进程 pipe 输入）
  // 可能丢失那些“没监听者时到达”的 line 事件。asyncIterator 内部维护了
  // 队列，每次 next() 能拿到下一行。
  const lineIterator = rl[Symbol.asyncIterator]();

  /**
   * 写 prompt 到 stdout（迷你版 rl.question），返回下一行。EOF/close 返回 null。
   *
   * prompt 走 io.stdout 而非 process.stdout：测试注入 io 时能一并截获提示符。
   */
  const readLine = async (prompt: string): Promise<string | null> => {
    io.stdout(prompt);
    const { value, done } = await lineIterator.next();
    return done ? null : value;
  };

  // ────────────── SIGINT 状态机 ──────────────
  // 包成 ref 对象：TS CFA 对 object property 不做循环外窄化，避免
  // 在循环体里 `if (phase.kind === "pending-exit")` 被误判为永假
  const phaseRef: { current: SigintPhase } = { current: { kind: "idle" } };

  const processSigintHandler = (): void => {
    const current = phaseRef.current;
    switch (current.kind) {
      case "streaming":
        // 中断当前流；agent loop 会抛 AbortError，下面主循环的 catch 接住
        current.abort.abort();
        // 先不改 phase，让 finally 块把它重置为 idle（避免并发重入）
        break;
      case "pending-exit":
        // 1.5s 内再按一次：退出
        clearTimeout(current.timer);
        process.exit(130);
        break;
      case "idle": {
        io.stderr("\n(再按一次 Ctrl+C 在 1.5 秒内退出；或继续输入。)\n");
        const timer = setTimeout(() => {
          // 超时回到普通 idle
          if (phaseRef.current.kind === "pending-exit") {
            phaseRef.current = { kind: "idle" };
          }
        }, PENDING_EXIT_WINDOW_MS);
        phaseRef.current = { kind: "pending-exit", timer };
        break;
      }
    }
  };

  // SIGINT 双路注册：
  // - TTY 模式：readline 内部监听 SIGINT 并重定向成 rl 的 "SIGINT" 事件，
  //   此时 process.on('SIGINT') 不会触发。必须监听 rl 才能拿到信号。
  // - 非 TTY（stdin 是 pipe）模式：readline 不接管 SIGINT，
  //   Node 默认流程会触发 process.on('SIGINT')。
  // 两路绑同一个 handler：每次 Ctrl+C 只会命中其中一条路径，不会重入。
  rl.on("SIGINT", processSigintHandler);
  process.on("SIGINT", processSigintHandler);

  // ────────────── PermissionProvider：给 ask 档的工具调用弹 5 档菜单 ──────────────
  // 只有 permissionStore 注入了才有意义（无 store 时 ask → deny，provider 不会被调用）
  const permissionProvider =
    permissionStore !== undefined ? createReplPermissionProvider({ io, readLine }) : undefined;

  // ────────────── PermissionModeRef：支持 /permissions mode 运行时切换 ──────────────
  // 封闭一个 mutable 变量包装 get/set，每轮 sendTurn 读取最新值
  const modeState: { current: PermissionMode } = {
    current: permissionMode ?? "default",
  };
  const permissionModeRef: PermissionModeRef = {
    get: () => modeState.current,
    set: (m) => {
      modeState.current = m;
    },
  };

  // ────────────── SlashIO：把 readline 的 readLine 封装成 confirm ──────────────
  const slashIO: SlashIO = {
    print: (text) => io.stderr(text),
    confirm: async (prompt) => {
      const line = await readLine(prompt);
      if (line === null) return false;
      const answer = line.trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };

  // ────────────── Welcome ──────────────
  io.stderr(
    [
      `nova-code chat（session: ${session.meta.sessionId}, model: ${session.meta.model}）`,
      "输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。",
      "",
    ].join("\n"),
  );

  // ────────────── 主循环 ──────────────
  try {
    while (true) {
      const line = await readLine("> ");
      if (line === null) {
        // stdin EOF / rl close → 正常退出
        printCostSummary(costTracker, io);
        io.stderr("\n");
        return 0;
      }
      const input = line.trim();
      if (input === "") {
        // 空行：什么都不做，重新 prompt；同时若处于 pending-exit 则不取消窗口——
        // 设计稿约定"空闲超时"才清窗口，用户空输入不算动作
        continue;
      }
      // 用户开始交互 → 清除 pending-exit 窗口
      const currentPhase = phaseRef.current;
      if (currentPhase.kind === "pending-exit") {
        clearTimeout(currentPhase.timer);
        phaseRef.current = { kind: "idle" };
      }

      // 斜杠命令优先
      // M4: 为 /compact 这类需要发 LLM 调用的命令准备 chatRuntime；
      // 复用 sendTurn 风格的 abortController + streaming 阶段，让 Ctrl+C 能中断 compact。
      const slashAbort = new AbortController();
      phaseRef.current = { kind: "streaming", abort: slashAbort };
      const currentTools = readCurrentTools();
      const dispatch = await dispatchSlash(input, {
        session,
        io: slashIO,
        ...(configSource ? { configSource } : {}),
        ...(permissionStore !== undefined ? { permissionStore } : {}),
        permissionModeRef,
        chatRuntime: {
          config,
          signal: slashAbort.signal,
          tools: currentTools,
          systemPrompt: buildSystemPrompt({
            toolNames: currentTools.map((tool) => tool.name),
            ...(projectInstructions !== undefined ? { projectInstructions } : {}),
          }),
          ...(llmLogSink !== undefined ? { llmLogSink } : {}),
          ...(costTracker !== undefined ? { costTracker } : {}),
        },
      });
      // 一旦 dispatch 完成 → 重置 phase 回 idle（无论 dispatch.handled 与否）
      phaseRef.current = { kind: "idle" };
      if (dispatch.handled) {
        if (dispatch.result.action === "exit") {
          printCostSummary(costTracker, io);
          return dispatch.result.exitCode ?? 0;
        }
        continue;
      }

      // 走真实 agent loop
      const abortController = new AbortController();
      phaseRef.current = { kind: "streaming", abort: abortController };
      const renderState = createRenderState();

      try {
        const gen = session.sendTurn(input, {
          config,
          tools: readCurrentTools(),
          signal: abortController.signal,
          ...(llmLogSink !== undefined ? { llmLogSink } : {}),
          permissionMode: modeState.current,
          ...(permissionStore !== undefined ? { permissionStore } : {}),
          ...(permissionProvider !== undefined ? { permissionProvider } : {}),
          cwd: process.cwd(),
          // M4: 自动 compact + CLAUDE.md 注入
          autoCompactEnabled,
          autoCompactTracking,
          ...(projectInstructions !== undefined ? { projectInstructions } : {}),
        });
        for await (const event of gen) {
          debugSink.write(event);
          recordCostEvent(event, config.model, costTracker);
          renderAgentEvent(event, io, renderState);
        }
      } catch (error) {
        handleTurnError(error, io);
      } finally {
        phaseRef.current = { kind: "idle" };
      }
    }
  } finally {
    process.removeListener("SIGINT", processSigintHandler);
    rl.close();
  }
}

function recordCostEvent(
  event: AgentEvent,
  model: string,
  costTracker: CostTracker | undefined,
): void {
  if (costTracker === undefined) return;
  if (event.type === "turn_end" && isApiUsage(event.message?.usage)) {
    costTracker.recordUsage(model, event.message.usage);
    return;
  }
  if (event.type === "compact_end" && isApiUsage(event.usage)) {
    costTracker.recordUsage(model, event.usage);
  }
}

function isApiUsage(value: unknown): value is ApiUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return typeof usage["input_tokens"] === "number" && typeof usage["output_tokens"] === "number";
}

function printCostSummary(costTracker: CostTracker | undefined, io: ReplIO): void {
  if (costTracker === undefined || !costTracker.hasUsage()) return;
  io.stderr(`${formatChatCostSummary(costTracker.snapshot())}\n`);
}

/** 把 sendTurn 抛出的错误映射为用户可见的一行提示；REPL 不退出。 */
function handleTurnError(error: unknown, io: ReplIO): void {
  if (error instanceof AbortError) {
    io.stderr("\n[cancelled]\n");
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`\n[error] ${message}\n`);
}

/** 生产路径的 ReplIO：包 process.stdout / process.stderr。 */
function defaultReplIO(): ReplIO {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}
