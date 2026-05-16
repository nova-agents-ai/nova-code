/**
 * chat 命令定义：进入多轮 REPL，允许连续对话、斜杠命令、会话持久化。
 *
 * 与 ask 的区别：
 *  - 不从 args / stdin 读一个 question 跑完退出；而是进入一个持续的 REPL
 *  - 支持 `--resume <id|alias>` 从本地 JSONL 恢复会话
 *  - debug sink 的文件名前缀用 "chat"、后缀用 sessionId（对齐 debugSink 的 prefix 参数）
 *
 * 错误映射：
 *  - ChatFlagsError：用户参数错，退出码 1
 *  - ConfigError：apiKey 未配置等；退出码 1，消息友好
 *  - 其余未预期异常：退出码 2，打印 error.message
 */

import { loadConfig } from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import { attachAnalyticsSink, logEvent } from "../../services/analytics/index.ts";
import { createDefaultAnalyticsSink } from "../../services/analytics/sink.ts";
import { appendCostLedgerEntry, CostTracker } from "../../services/cost/index.ts";
import { createMcpToolRegistry, type McpToolRegistry } from "../../services/mcp/index.ts";
import { PermissionStore } from "../../services/permissions/permissionStore.ts";
import { getProjectInstructions } from "../../services/projectInstructions/index.ts";
import { builtinTools } from "../../tools.ts";
import { createFileDebugSink, type DebugSink, NULL_DEBUG_SINK } from "../AskCommand/debugSink.ts";
import type { CommandDefinition } from "../types.ts";
import { ChatSession } from "./ChatSession.ts";
import { ChatFlagsError, parseChatFlags } from "./parseChatFlags.ts";
import { runChatRepl } from "./runChatRepl.ts";
import { generateSessionId } from "./sessionId.ts";
import { loadSession } from "./sessionStore.ts";

export const chatCommand: CommandDefinition = {
  name: "chat",
  description: "进入多轮 chat REPL：连续对话 + 斜杠命令 + 会话持久化",
  usage:
    "nova-code chat [--debug] [--debug-pretty] [--resume <id|alias>] [--dangerously-skip-permissions]\n" +
    "  --debug:        把完整 AgentEvent 流写入 ~/.nova-code/logs/chat-*.log\n" +
    "  --debug-pretty: 隐含 --debug；日志多行缩进 + 字符串内换行展开\n" +
    "  --resume:       从 ~/.nova-code/sessions/<id>.jsonl 恢复会话\n" +
    "  --dangerously-skip-permissions: 跳过权限询问，仅 DENY_PATTERNS 拦截",
  run: async (args) => {
    // 启动即 attach 默认 sink（幂等）：保证所有早期 logEvent 调用最终都被排空
    attachAnalyticsSink(createDefaultAnalyticsSink());

    let debug = false;
    let pretty = false;
    let resumeId: string | undefined;
    let dangerouslySkipPermissions = false;
    try {
      const flags = parseChatFlags(args);
      debug = flags.debug;
      pretty = flags.pretty;
      resumeId = flags.resumeId;
      dangerouslySkipPermissions = flags.dangerouslySkipPermissions;
    } catch (error) {
      if (error instanceof ChatFlagsError) {
        console.error(`chat: ${error.message}`);
        return 1;
      }
      throw error;
    }

    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = await loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`\nchat: ${error.message}`);
        return 1;
      }
      throw error;
    }

    const costTracker = new CostTracker();

    // 构造 ChatSession：新开或从 --resume 加载
    let session: ChatSession;
    try {
      session = resumeId === undefined ? newSession(config.model) : await resumeSession(resumeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nchat: 加载会话失败：${message}`);
      return 1;
    }

    // debug sink 用 chat 前缀 + sessionId 后缀
    const debugSink: DebugSink = debug
      ? createFileDebugSink({
          pretty,
          prefix: "chat",
          sessionId: session.meta.sessionId,
        })
      : NULL_DEBUG_SINK;
    // LLM 原始请求/响应日志写入独立文件（chat-llm-*.log），与 AgentEvent 日志并列
    const llmLogSink: DebugSink = debug
      ? createFileDebugSink({
          pretty,
          prefix: "chat-llm",
          sessionId: session.meta.sessionId,
        })
      : NULL_DEBUG_SINK;
    let mcpRegistry: McpToolRegistry | undefined;

    // 加载三层权限规则（session + project + global）。
    // 文件不存在/空不是错；ConfigError 走与 loadConfig 同样的退出码 1 通道。
    let permissionStore: PermissionStore;
    try {
      permissionStore = await PermissionStore.load(process.cwd());
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`\nchat: ${error.message}`);
        return 1;
      }
      throw error;
    }

    try {
      mcpRegistry = await createMcpToolRegistry(config);
      for (const warning of mcpRegistry.warnings) {
        process.stderr.write(`[mcp] ${warning}\n`);
      }

      if (debug && debugSink.logFilePath !== null) {
        process.stderr.write(`[debug] log file: ${debugSink.logFilePath}\n`);
        if (llmLogSink.logFilePath !== null) {
          process.stderr.write(`[debug] llm log file: ${llmLogSink.logFilePath}\n`);
        }
        if (pretty) {
          process.stderr.write("[debug] pretty mode: on\n");
        }
      }

      // M4: 启动时一次性加载 CLAUDE.md 4 层（不抛错；缺失时 undefined）
      const projectInstructions = await getProjectInstructions({ cwd: process.cwd() });

      logEvent("tengu_started", {
        command: "chat",
        model: config.model,
        resumed: resumeId !== undefined,
        dangerouslySkipPermissions,
        hasProjectInstructions: projectInstructions !== undefined,
        mcpToolCount: mcpRegistry.tools.length,
      });

      const exitCode = await runChatRepl({
        session,
        config,
        tools: [...builtinTools, ...mcpRegistry.tools],
        getTools: () => [...builtinTools, ...(mcpRegistry?.tools ?? [])],
        debugSink,
        llmLogSink: debug ? llmLogSink : undefined,
        permissionStore,
        // --dangerously-skip-permissions → bypassPermissions，否则 default
        permissionMode: dangerouslySkipPermissions ? "bypassPermissions" : "default",
        ...(projectInstructions !== undefined ? { projectInstructions } : {}),
        costTracker,
      });
      await appendChatCostLedgerBestEffort(costTracker, session.meta.sessionId, exitCode);
      logEvent("tengu_exit", { command: "chat", exitCode });
      return exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nchat: ${message}`);
      logEvent("tengu_exit", { command: "chat", exitCode: 2, errored: true });
      return 2;
    } finally {
      debugSink.close();
      llmLogSink.close();
      await mcpRegistry?.close();
    }
  },
};

async function appendChatCostLedgerBestEffort(
  costTracker: CostTracker,
  sessionId: string,
  exitCode: number,
): Promise<void> {
  if (!costTracker.hasUsage()) return;
  try {
    await appendCostLedgerEntry({
      entry: {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        command: "chat",
        sessionId,
        exitCode,
        snapshot: costTracker.snapshot(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cost] failed to write ledger: ${message}\n`);
  }
}

/** 新会话：生成 sessionId + 记下 model；不写盘，等用户 /save 时落地。 */
function newSession(model: string): ChatSession {
  const sessionId = generateSessionId();
  return new ChatSession({
    sessionId,
    model,
    createdAt: new Date().toISOString(),
  });
}

/** 从本地 JSONL 恢复会话，带出历史消息。 */
async function resumeSession(idOrAlias: string): Promise<ChatSession> {
  const snapshot = await loadSession(idOrAlias);
  return new ChatSession(snapshot.meta, snapshot.messages);
}
