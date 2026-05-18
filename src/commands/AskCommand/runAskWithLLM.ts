/**
 * ask 命令的 LLM 调用主循环：负责串起配置加载、agent loop、debug sink、错误映射。
 *
 * 流程：
 * 1. 加载配置（缺 API key 时友好报错并提示如何配置）
 * 2. 跑 agent loop，把流式文本增量直接写到 stdout
 * 3. 工具调用以单行提示形式输出到 stderr，避免污染答案本身
 * 4. debug 模式下：整份 AgentEvent 流追加到 ~/.nova-code/logs/ask-<timestamp>-<pid>.log
 *    （**不写 stderr**，避免污染交互；用户只在 stderr 看到一行 "log file: ..." 提示）
 * 5. --debug-pretty 进一步把日志文件格式化：多行缩进 + 把字符串里的 \n 渲染成真换行
 *
 * 退出码：0 = 正常结束；1 = 配置错误；2 = LLM/工具失败；130 = 用户中断
 */

import { loadConfig } from "../../config/config.ts";
import { AbortError, ConfigError, MaxTurnsExceededError } from "../../errors/index.ts";
import { runAgentLoop } from "../../QueryEngine.ts";
import { attachAnalyticsSink, logEvent } from "../../services/analytics/index.ts";
import { createDefaultAnalyticsSink } from "../../services/analytics/sink.ts";
import { LLMApiError } from "../../services/api/errors.ts";
import { createAutoCompactTrackingState } from "../../services/compact/autoCompact.ts";
import { HookExecutionOutcome } from "../../services/hooks/types.ts";
import { createMcpToolRegistry, type McpToolRegistry } from "../../services/mcp/index.ts";
import { PermissionStore } from "../../services/permissions/permissionStore.ts";
import {
  loadPluginCatalog,
  mergeHooksConfig,
  mergeMcpServersConfig,
  resolvePluginSlashInvocation,
} from "../../services/plugins/index.ts";
import { createProjectInstructionsRuntime } from "../../services/projectInstructions/index.ts";
import {
  formatSkillListingInstructions,
  loadSkillCatalog,
  mergeInstructionBlocks,
  resolveSkillSlashInvocation,
} from "../../services/skills/index.ts";
import { TODO_WRITE_TOOL_NAME } from "../../tools/TodoWriteTool/constants.ts";
import { builtinTools, createSkillTool } from "../../tools.ts";
import { createFileDebugSink, type DebugSink, NULL_DEBUG_SINK } from "./debugSink.ts";
import { createHeadlessPermissionProvider } from "./headlessPermissionProvider.ts";

export interface RunAskOptions {
  readonly debug: boolean;
  readonly pretty: boolean;
  /**
   * --dangerously-skip-permissions 映射而来：打开后 permissionMode 从
   * "acceptEdits" 升级到 "bypassPermissions"（DENY_PATTERNS 仍拦截）。
   */
  readonly dangerouslySkipPermissions?: boolean;
}

export async function runAskWithLLM(question: string, options: RunAskOptions): Promise<number> {
  // 启动即 attach 默认 sink（幂等）
  attachAnalyticsSink(createDefaultAnalyticsSink());

  // Ctrl+C：转成 abort signal 让 agent loop 优雅退出
  const abortController = new AbortController();
  const onSigint = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", onSigint);

  // debug sink 在 try 之外创建，但 close 一定要在 finally 兜底
  const debugSink: DebugSink = options.debug
    ? createFileDebugSink({ pretty: options.pretty })
    : NULL_DEBUG_SINK;
  // LLM 原始请求/响应日志写入独立文件（ask-llm-*.log），与 AgentEvent 日志并列
  const llmLogSink: DebugSink = options.debug
    ? createFileDebugSink({ pretty: options.pretty, prefix: "ask-llm" })
    : NULL_DEBUG_SINK;
  let mcpRegistry: McpToolRegistry | undefined;

  try {
    if (options.debug && debugSink.logFilePath !== null) {
      // 让用户知道完整日志去哪儿了；此条只走 stderr，不入日志文件（避免冗余）
      process.stderr.write(`[debug] log file: ${debugSink.logFilePath}\n`);
      if (llmLogSink.logFilePath !== null) {
        process.stderr.write(`[debug] llm log file: ${llmLogSink.logFilePath}\n`);
      }
      if (options.pretty) {
        process.stderr.write("[debug] pretty mode: on\n");
      }
    }

    const config = await loadConfig();
    const pluginCatalog = await loadPluginCatalog({ cwd: process.cwd() });
    for (const warning of pluginCatalog.warnings) {
      process.stderr.write(`[plugin] ${warning}\n`);
    }
    const effectiveHooks = mergeHooksConfig(config.hooks, pluginCatalog.hooks);
    const effectiveMcpServers = mergeMcpServersConfig(config.mcpServers, pluginCatalog.mcpServers);
    const effectiveConfig = { ...config, hooks: effectiveHooks, mcpServers: effectiveMcpServers };
    mcpRegistry = await createMcpToolRegistry(effectiveConfig);
    for (const warning of mcpRegistry.warnings) {
      process.stderr.write(`[mcp] ${warning}\n`);
    }
    // 加载三层权限规则；headless 模式下依然有 project/global 预先写入的规则
    const permissionStore = await PermissionStore.load(process.cwd());
    // headless provider：所有 ask 档统一 deny，在 stderr 留一行提示
    const permissionProvider = createHeadlessPermissionProvider({
      stderr: (t) => process.stderr.write(t),
    });
    // M4/M12: 启动时加载 CLAUDE.md + eager rules；path-scoped rules 由 runtime 延迟激活。
    const projectInstructionsRuntime = await createProjectInstructionsRuntime({
      cwd: process.cwd(),
      hooks: effectiveHooks,
      sessionId: "ask",
      signal: abortController.signal,
      pluginRuleContributions: pluginCatalog.ruleContributions,
    });
    const skillCatalog = await loadSkillCatalog({
      cwd: process.cwd(),
      extraRoots: pluginCatalog.skillRoots,
    });
    for (const warning of skillCatalog.warnings) {
      process.stderr.write(`[skill] ${warning}\n`);
    }
    const skillSlashInvocation = resolveSkillSlashInvocation(question, skillCatalog.skills);
    if (skillSlashInvocation?.kind === "blocked") {
      process.stderr.write(`ask: ${skillSlashInvocation.message}\n`);
      return 1;
    }
    const pluginSlashInvocation = resolvePluginSlashInvocation(
      question,
      pluginCatalog.slashCommands,
    );
    const userPrompt =
      skillSlashInvocation?.kind === "invoke"
        ? skillSlashInvocation.prompt
        : (pluginSlashInvocation?.prompt ?? question);

    const skillListingInstructions = formatSkillListingInstructions(skillCatalog.skills);
    const runtimeInstructions = mergeInstructionBlocks(skillListingInstructions);
    const skillTool = createSkillTool(skillCatalog.skills);
    const tools = [
      ...builtinTools,
      ...(skillTool !== undefined ? [skillTool] : []),
      ...mcpRegistry.tools,
    ];
    const autoCompactTracking = createAutoCompactTrackingState();
    logEvent("tengu_started", {
      command: "ask",
      model: config.model,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions === true,
      hasProjectInstructions: projectInstructionsRuntime.getInstructions() !== undefined,
      skillCount: skillCatalog.skills.length,
      skillNames: skillCatalog.skills.map((skill) => skill.name).join(","),
      mcpToolCount: mcpRegistry.tools.length,
      pluginCount: pluginCatalog.plugins.length,
      enabledPluginCount: pluginCatalog.plugins.filter((plugin) => plugin.enabled).length,
    });
    let inAssistantText = false;

    if (options.debug) {
      // 把生效配置脱敏后写入日志，便于排查"为什么连到了错误的 endpoint"
      debugSink.write({
        type: "config_loaded",
        model: config.model,
        baseURL: config.baseURL ?? null,
        apiKeyTail: config.apiKey.slice(-4),
      });
    }

    const generator = runAgentLoop({
      config: effectiveConfig,
      userPrompt,
      tools,
      signal: abortController.signal,
      llmLogSink: options.debug ? llmLogSink : undefined,
      // ask 默认 acceptEdits：FileWrite/FileEdit 直接放行（便于常见 "生成代码"
      // 场景），Bash 仍走规则判定→ask→headless deny
      // --dangerously-skip-permissions → bypassPermissions
      permissionMode:
        options.dangerouslySkipPermissions === true ? "bypassPermissions" : "acceptEdits",
      permissionStore,
      permissionProvider,
      cwd: process.cwd(),
      // M4/M12: 默认开启 auto-compact，并注入项目指令 runtime 与 skill listing。
      autoCompactEnabled: true,
      autoCompactTracking,
      ...(runtimeInstructions !== undefined ? { projectInstructions: runtimeInstructions } : {}),
      projectInstructionsRuntime,
      hooks: effectiveHooks,
      sessionId: "ask",
    });

    for await (const event of generator) {
      debugSink.write(event);

      switch (event.type) {
        case "turn_start":
          // 第二轮起在工具调用之后，加一个空行让回答与工具输出分隔开
          if (event.turn > 1) {
            process.stderr.write("\n");
          }
          break;
        case "text_delta":
          process.stdout.write(event.delta);
          inAssistantText = true;
          break;
        case "tool_call":
          if (inAssistantText) {
            process.stdout.write("\n");
            inAssistantText = false;
          }
          process.stderr.write(`\n[tool] ${event.toolName} ${JSON.stringify(event.input)}\n`);
          break;
        case "tool_result":
          if (event.isError) {
            process.stderr.write(`[tool] ${event.toolName} failed: ${event.content}\n`);
          } else if (event.toolName === TODO_WRITE_TOOL_NAME) {
            process.stderr.write(`${event.content}\n`);
          }
          break;
        case "hook_result":
          if (event.outcome === HookExecutionOutcome.BLOCKING) {
            process.stderr.write(
              `[hook] ${event.hookEventName}:${event.toolName} blocked (${event.command}): ${formatHookOutput(
                event.stderr,
                event.stdout,
              )}\n`,
            );
          } else if (event.outcome === HookExecutionOutcome.NON_BLOCKING_ERROR) {
            process.stderr.write(
              `[hook] ${event.hookEventName}:${event.toolName} warning (${event.command}): ${formatHookOutput(
                event.stderr,
                event.stdout,
              )}\n`,
            );
          } else if (event.outcome === HookExecutionOutcome.CANCELLED) {
            process.stderr.write(
              `[hook] ${event.hookEventName}:${event.toolName} cancelled (${event.command})\n`,
            );
          }
          break;
        case "done":
          // 末尾补一个换行，避免 shell 提示符紧贴输出
          process.stdout.write("\n");
          break;
        // turn_end 当前不需要展示给用户（debug 模式已通过 debugSink 输出）
        case "turn_end":
          break;
        case "permission_request":
          // M3：在 headless ask 下，PermissionProvider 负责决策（默认 acceptEdits），
          // 本分支仅给出可见提示。inAssistantText 以 case "tool_call" 同理补换行。
          if (inAssistantText) {
            process.stdout.write("\n");
            inAssistantText = false;
          }
          process.stderr.write(`[permission] asking: ${event.toolName} (${event.reason})\n`);
          break;
        case "permission_decision":
          if (event.decision === "deny") {
            process.stderr.write(`[permission] denied: ${event.toolName} (${event.reason})\n`);
          }
          break;
        case "compact_start":
          if (inAssistantText) {
            process.stdout.write("\n");
            inAssistantText = false;
          }
          process.stderr.write(
            `[compact] auto-compacting (≈ ${event.preCompactTokenCount} tokens)\n`,
          );
          break;
        case "compact_end":
          if (event.error !== undefined) {
            process.stderr.write(`[compact] failed: ${event.error}\n`);
          } else if (event.postCompactTokenCount !== undefined) {
            process.stderr.write(
              `[compact] done: ${event.preCompactTokenCount} → ${event.postCompactTokenCount} tokens\n`,
            );
          }
          break;
      }
    }
    logEvent("tengu_exit", { command: "ask", exitCode: 0 });
    return 0;
  } catch (error) {
    const code = handleAskError(error);
    logEvent("tengu_exit", { command: "ask", exitCode: code, errored: true });
    return code;
  } finally {
    debugSink.close();
    llmLogSink.close();
    await mcpRegistry?.close();
    process.removeListener("SIGINT", onSigint);
  }
}

function formatHookOutput(stderr: string, stdout: string): string {
  const output = stderr.trim() || stdout.trim();
  if (output === "") return "no output";
  return output.split("\n")[0] ?? output;
}

/** 把不同错误映射到合适的退出码 + 用户友好的提示。 */
function handleAskError(error: unknown): number {
  if (error instanceof ConfigError) {
    console.error(`\nask: ${error.message}`);
    return 1;
  }
  if (error instanceof AbortError) {
    console.error("\nask: 已中断。");
    return 130;
  }
  if (error instanceof MaxTurnsExceededError) {
    console.error(`\nask: ${error.message}`);
    return 2;
  }
  if (error instanceof LLMApiError) {
    const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
    console.error(`\nask: LLM 请求失败${status}：${error.message}`);
    return 2;
  }
  if (error instanceof Error) {
    console.error(`\nask: ${error.message}`);
    return 2;
  }
  console.error(`\nask: ${String(error)}`);
  return 2;
}
