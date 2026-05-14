# M4 子系统全景

## 1. 目录增量

```
src/
├── services/
│   ├── compact/                    ← 新增（M4）
│   │   ├── index.ts
│   │   ├── contextWindow.ts        阈值常量与查表
│   │   ├── tokens.ts               ApiUsage / 锚点估算
│   │   ├── prompt.ts               summary prompt 模板
│   │   ├── compact.ts              主路径 compactConversation
│   │   ├── partialCompact.ts       回退路径（保留尾部 N 轮）
│   │   ├── autoCompact.ts          shouldAutoCompact + circuit breaker
│   │   └── *.test.ts
│   ├── projectInstructions/         ← 新增（M4）
│   │   ├── index.ts
│   │   ├── pathDiscovery.ts        findGitRoot + getDirectoryChain
│   │   ├── claudeMd.ts             marked Lexer + 4 层 + @include + html comment strip
│   │   └── claudeMd.test.ts
│   └── analytics/                   ← 新增（M4，复刻 claude-code logEvent）
│       ├── index.ts                logEvent + ringBuffer + subscribe + JSONL 落盘
│       └── index.test.ts
├── QueryEngine.ts                   ← 改造：每轮 turn 之前调 autoCompactIfNeeded；
│                                       systemPrompt 拼 projectInstructions
├── types/message.ts                 ← AgentEvent +compact_start / compact_end
└── commands/
    ├── ChatCommand/
    │   ├── ChatSession.ts          ← 新增 compact() 方法 + ChatCompactContext 类型
    │   ├── runChatRepl.ts          ← 注入 autoCompactTracking + projectInstructions
    │   ├── renderAgentEvent.ts     ← 渲染 compact_start / compact_end
    │   ├── ChatCommand.ts          ← 启动时 getProjectInstructions 一次
    │   └── slash/
    │       ├── compact.ts          /compact 斜杠命令（新增）
    │       ├── compact.test.ts
    │       ├── types.ts            ← SlashContext +chatRuntime 字段
    │       └── registry.ts         ← +compactCommand
    └── AskCommand/
        └── runAskWithLLM.ts        ← 同款注入 + 渲染 compact 事件
```

## 2. 与 M3 的耦合点

| 维度 | M3 状态 | M4 增量 |
|---|---|---|
| QueryEngine 主循环 | Phase A/B/C 权限三阶段 | 在 Phase A 之**前**插一步 autoCompactIfNeeded；compact 触发后 messages 数组被替换，不影响后续 Phase A/B/C |
| AgentLoopParams | 4 个权限字段 + cwd | +3 个 M4 字段（autoCompactEnabled / autoCompactTracking / projectInstructions） |
| AgentEvent | 7 类（含 permission_*） | +2 类（compact_start / compact_end），共 9 类 |
| ChatTurnContext | +permissionMode/Store/Provider | +autoCompactEnabled/Tracking/projectInstructions |
| SlashContext | +permissionStore + permissionModeRef | +chatRuntime（给 /compact 这类需要发 LLM 的命令） |

## 3. 一次自动 compact 穿过的层

```
用户输入 q5（chat REPL idle 阶段）
  │
  ▼
runChatRepl 主循环：
  └─ session.sendTurn("q5", ctx)
       └─ ChatSession：本地 newMessages 追加 user "q5"
            └─ runAgentLoop({initialMessages, userPrompt:"q5", autoCompactTracking, ...})
                 ├─ for turn=1
                 ├─   ┌─ tryAutoCompact ◀────────────────────────────
                 ├─   │   ├─ shouldAutoCompact(messages, enabled)
                 ├─   │   │   = tokenCountWithEstimation(messages)
                 ├─   │   │     ≥ getAutoCompactThreshold(model)
                 ├─   │   ├─ yield compact_start
                 ├─   │   ├─ autoCompactIfNeeded:
                 ├─   │   │     compactConversation({messages, client, ...})
                 ├─   │   │       └─ client.messages.stream({same system/tools, tool_choice:none})
                 ├─   │   │       └─ 解析 <summary> → summaryMessage
                 ├─   │   ├─ tracking.compacted = true
                 ├─   │   └─ yield compact_end
                 ├─   ├─ replaced=true → messages.length=0; messages.push(summary)
                 ├─   └─ streamOneTurn 用替换后的 messages 调一次 LLM
                 └─ assistantMessage.usage = final.usage（更新 usage 锚点）
```

## 4. 一次 /compact 穿过的层

```
用户输入 "/compact focus on tests"
  │
  ▼
runChatRepl 主循环：
  └─ phase = streaming（带 abortController）
  └─ dispatchSlash("/compact focus on tests", {chatRuntime: {config, signal, llmLogSink}})
       └─ findSlashCommand("compact") = compactCommand
       └─ compactCommand.run(ctx):
            └─ session.compact(
                 {config, signal, llmLogSink},
                 "focus on tests",
               )
                 └─ 快照 snapshot = this.messages
                 └─ compactConversation({messages: snapshot, ..., trigger: "manual"})
                      └─ 同上 LLM 调用 + 解析 summary
                 └─ this.messages = [summaryMessage]（成功后原子替换）
            └─ io.print("已压缩 N 条消息 → 1 条 summary (≈ X → Y tokens)")
       ← phase = idle
```

## 5. AgentEvent 扩展

```ts
// 新增两类（types/message.ts）
| { type: "compact_start"; trigger: CompactTrigger; preCompactTokenCount: number }
| { type: "compact_end"; trigger: CompactTrigger; preCompactTokenCount: number;
    postCompactTokenCount?: number; error?: string }

export type CompactTrigger = "auto" | "manual";
```

`renderAgentEvent` 在 chat REPL / ask CLI 中分别渲染单行 stderr 提示，与 `[tool]` / `[permission]` 视觉风格一致：

```
[compact] auto-compacting (≈ 168432 tokens)
[compact] done: 168432 → 612 tokens
```

错误形态：

```
[compact] failed: <error message>
```

## 6. Telemetry / logEvent —— 两层架构

**位置**：`src/services/analytics/`

复刻 claude-code 的两层架构（**Layer 1 门面 + Layer 2 sink**），目录形态、文件名、
公共 API 均与 claude-code 同形：

```
services/analytics/
├── index.ts        ← Layer 1 门面：零依赖，只有 eventQueue + 单一 sink + queueMicrotask 异步排空
└── sink.ts         ← Layer 2 默认 sink：ringBuffer + 可选 JSONL 落盘（实现细节）
```

### 6.1 Layer 1：门面（`index.ts`）

**关键不变量**（claude-code 文件头注释里也强调过的）：
1. **零依赖** —— 不 import 任何 nova-code 内部模块，避免 import cycles
2. **attach 前 enqueue**：sink 还没附着时所有 `logEvent` / `logEventAsync` 都进 `eventQueue`
3. **attach 时 queueMicrotask 异步排空**：不阻塞启动路径
4. **attachAnalyticsSink 幂等**：已附着时直接 no-op
5. **永不抛**：sink 抛错被门面层吞掉

公共 API：

| 函数 | 用途 |
|---|---|
| `logEvent(name, payload?)` | 同步投递事件（最常用） |
| `logEventAsync(name, payload?)` | 返回 Promise；调用方可 await（如退出前 flush） |
| `attachAnalyticsSink(sink)` | 启动时一次性附着 sink；幂等 |
| `_resetAnalyticsForTests()` | 单测重置门面状态 |

### 6.2 Layer 2：默认 sink（`sink.ts`）

`createDefaultAnalyticsSink(opts)` 返回 `DefaultAnalyticsSink`，其 `logEvent` /
`logEventAsync` 实际做：
- 256 条环形 buffer（payload 注入 `capacity` 可调）→ `getBuffer()` 暴露给 future `/events` 命令
- 可选 JSONL 落盘：env `NOVA_TELEMETRY_FILE=<path>` 时启用；用 promise 链串行化，避免 read-modify-write race
- env `NOVA_DISABLE_TELEMETRY=1/true` 时直接返回 noop sink（buffer 永远为空、文件永远不写）

第三方扩展点：M9+ 接 Datadog / OTEL 时实现 `AnalyticsSink` 接口即可，不需要改门面层。

### 6.3 启动时附着

`ChatCommand.run` / `runAskWithLLM` 在主流程开始时各自调一次 `attachAnalyticsSink(createDefaultAnalyticsSink())`。
幂等设计保证两条路径不会冲突。库使用者可在调用 `runAgentLoop` 之前
attach 自定义 sink 接管事件。

M4 落地后埋点已铺满 M0–M4 全栈（事件名沿用 `tengu_` 前缀，跨参考定位用）：

**M0 / M1.5 — API 与 Agent Loop**
| 位置 | 事件名 | 触发时机 |
|---|---|---|
| QueryEngine.streamOneTurn | `tengu_api_query` | 每轮 LLM 请求发出前 |
| QueryEngine.streamOneTurn | `tengu_api_success` | 流结束、finalMessage 拿到 |
| QueryEngine.streamOneTurn | `tengu_api_error` | 流异常或 finalMessage 异常（带 stage = stream / finalMessage） |
| services/api/withRetry | `tengu_api_retry` | withRetry 决定下一次重试前 |

**M1 — Bash 工具**
| 位置 | 事件名 | 触发时机 |
|---|---|---|
| BashTool | `tengu_bash_security_check_triggered` | HARD_BANNED_PATTERNS 命中（执行被拒） |
| BashTool | `tengu_bash_tool_command_executed` | 命令成功 spawn + 完成（携带 commandHead / exitCode / timedOut） |

**M2 — chat REPL / Session / Slash**
| 位置 | 事件名 | 触发时机 |
|---|---|---|
| sessionStore.loadSession | `tengu_session_file_read` | /load + --resume 成功读出 snapshot |
| slash/dispatcher | `tengu_input_slash_invalid` | 用户输入未注册的 /xxx |
| slash/dispatcher | `tengu_input_slash_missing` | 用户只输入了一个 `/` |

**M3 — 权限**
| 位置 | 事件名 | 触发时机 |
|---|---|---|
| permissionEngine.evaluatePermission | `tengu_internal_record_permission_context` | 每次 7 步流水线给出决策（payload: tool/mode/decision/source） |
| replPermissionProvider | `tengu_permission_request_option_selected` | REPL 5 档菜单用户选择落定（含 EOF deny） |

**M4 — Compact + CLAUDE.md**
| 位置 | 事件名 | 触发时机 |
|---|---|---|
| compact.ts | `tengu_compact` | compactConversation 入口（每次开始） |
| compact.ts | `tengu_compact_done` | compactConversation 成功结束 |
| compact.ts | `tengu_compact_error` | compactConversation 抛错（含 empty_summary 与 LLM 异常） |
| autoCompact.ts | `tengu_autocompact_failure` | 单次自动 compact 失败 |
| autoCompact.ts | `tengu_autocompact_circuit_breaker_skip` | breaker 已触发后又有满足阈值的请求 |
| autoCompact.ts | `tengu_autocompact_circuit_breaker_tripped` | 第 3 次失败让 breaker 关上 |
| claudeMd.ts | `tengu_claude_md_permission_error` | 加载 CLAUDE.md 时遇到 EACCES |
| claudeMd.ts | `tengu_claude_md_include_skipped_extension` | @include 子文件因扩展名不在白名单被跳 |

**CLI 入口生命周期**
| 位置 | 事件名 | 触发时机 |
|---|---|---|
| ChatCommand / runAskWithLLM | `tengu_started` | 命令启动后、进入主循环前 |
| ChatCommand / runAskWithLLM | `tengu_exit` | 主循环退出（成功 / 错误均发，errored 字段标识） |

## 7. 向后兼容

`AgentLoopParams` 的三个 M4 字段都可选；不传则 runAgentLoop 行为与 M3 完全一致：
- 主循环不调 `tryAutoCompact`
- system prompt 不拼 projectInstructions
- AgentEvent 流不会出现 compact_start / compact_end

M3 既有 67 条 QueryEngine + ChatSession 单测、M2 既有 e2e 测试均 0 改动通过。
