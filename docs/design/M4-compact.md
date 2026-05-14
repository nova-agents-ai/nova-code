# M4 — 上下文压缩 + CLAUDE.md 注入

> 实施日期：2026-05-12
>
> 目标：长对话不再因为撞上模型上下文窗口而中断；用户主动 `/compact` 也能强制压缩；同时启动时把 CLAUDE.md 4 层指令拼进 system prompt，让模型遵循项目级约定。

---

## 1. 设计总览

### 1.1 三块拼图

```
┌──────────────────────┐  ┌─────────────────────┐  ┌──────────────────────┐
│ services/compact/    │  │ services/projectIns │  │ slash/compact.ts     │
│  · contextWindow.ts  │  │  · pathDiscovery.ts │  │  · 用户 /compact     │
│  · tokens.ts         │  │  · claudeMd.ts      │  │  · ChatSession       │
│  · prompt.ts         │  │  · 4 层 + @include  │  │      .compact()      │
│  · compact.ts        │  └─────────────────────┘  └──────────────────────┘
│  · partialCompact.ts │
│  · autoCompact.ts    │  ── 启动时一次加载 ──         ── 运行时按需触发 ──
└──────────────────────┘
         │                          │                          │
         └────────────────┬─────────┘                          │
                          ▼                                    │
                ┌─────────────────────┐                        │
                │  QueryEngine.ts     │ ◀──────────────────────┘
                │  · 每轮 turn 之前   │
                │    autoCompact 判定 │
                │  · system prompt 拼 │
                │    projectInstr.    │
                └─────────────────────┘
```

### 1.2 自动 compact 七步流水线

QueryEngine 主循环每轮在 `streamOneTurn` 之前调一次：

```
1. enabled 关闭            → 直接 no-op
2. circuit breaker         → 连续失败 ≥ 3 次，本会话停用
3. shouldAutoCompact 判阈   → 估算 token < 阈值即 no-op
4. yield compact_start 事件 → UI 显示进度
5. compactConversation     → 一次无工具 LLM 调用，返回 summary
6. yield compact_end 事件   → 含成功 token 数 / 失败原因
7. 替换 messages = [summary] → 下一轮 streamOneTurn 用新对话历史
```

### 1.3 触发阈值的常量栈

```
              200,000  ← 模型上下文窗口（claude-sonnet-4-5/opus-4-7/haiku-4-5）
       -      20,000   ← MAX_OUTPUT_TOKENS_FOR_SUMMARY（给 summary 输出留空间）
       =     180,000   ← effectiveContextWindowSize
       -      13,000   ← AUTOCOMPACT_BUFFER_TOKENS（安全余量）
       =     167,000   ← autoCompactThreshold
```

token 估算用 `tokenCountWithEstimation`：从 messages 末尾向前找最近一条携带 SDK `usage` 的 assistant message，以其 `input + cache + output` 为锚点，加上锚点之后新增 messages 的 `chars/4` 估算。

### 1.4 /compact 手动语义

- 强制压缩，无视阈值（`compactConversation` 直接调）
- 走 `trigger: "manual"`：summary 文本不附 "Continue the conversation" 段落，让用户能审阅
- 直接重置 `ChatSession.messages = [summaryMessage]`
- 支持 `/compact <自定义指令>`：`args` 拼成 customInstructions 透传到 prompt

### 1.5 CLAUDE.md 4 层加载顺序

```
低 ──────────────────────────────────────────────────────── 高
managed     user        project chain          local chain
/etc/...    ~/.nova-    [gitRoot..cwd]/CLAUDE  [gitRoot..cwd]/
            code/                              CLAUDE.local.md
            CLAUDE.md
```

后加载者优先（在结果字符串中靠后），`@include` 子文件先于 parent 加载。

---

## 2. 代码组织

```
src/services/compact/
├── index.ts                  公共导出
├── contextWindow.ts          常量栈 + getContextWindowForModel + getEffectiveContextWindowSize
├── tokens.ts                 ApiUsage on NovaMessage + tokenCountWithEstimation
├── prompt.ts                 BASE / PARTIAL prompt + formatCompactSummary +
│                              getCompactUserSummaryMessage
├── compact.ts                compactConversation 主路径 + CompactionResult +
│                              ERROR_MESSAGE_NOT_ENOUGH_MESSAGES /
│                              ERROR_MESSAGE_INCOMPLETE_RESPONSE
├── partialCompact.ts         partialCompactConversation（roadmap 失败回退方案，
│                              keepRecent=5 保留尾部）
├── autoCompact.ts            AutoCompactTrackingState + shouldAutoCompact +
│                              autoCompactIfNeeded（含 circuit breaker）
└── *.test.ts

src/services/projectInstructions/
├── index.ts                  公共导出
├── pathDiscovery.ts          findGitRoot + getDirectoryChain
├── claudeMd.ts               marked Lexer + 4 层加载 +
│                              extractIncludePathsFromTokens + stripHtmlComments +
│                              TEXT_FILE_EXTENSIONS + 循环检测 + MAX_INCLUDE_DEPTH=5
└── claudeMd.test.ts

src/services/analytics/
├── index.ts                  Layer 1 门面：零依赖、eventQueue + 单一 sink +
│                              attachAnalyticsSink (queueMicrotask 异步排空) +
│                              logEvent / logEventAsync 双接口
├── index.test.ts             门面单测：attach 前 enqueue / queueMicrotask 排空
│                              / 幂等 / sink 抛错被吞 / sync vs async 区分
├── sink.ts                   Layer 2 默认 sink：ringBuffer + 可选 JSONL 落盘 +
│                              NOVA_DISABLE_TELEMETRY noop / DefaultAnalyticsSink
│                              暴露 getBuffer 给 future /events 命令
└── sink.test.ts              sink 单测：buffer / 环形覆盖 / disable / 落盘 race

src/QueryEngine.ts            AgentLoopParams +3 字段（autoCompactEnabled /
                              autoCompactTracking / projectInstructions）
                              新增 tryAutoCompact helper + system prompt 拼接

src/commands/ChatCommand/
├── ChatSession.ts            +compact() 方法 + ChatCompactContext 类型
├── runChatRepl.ts            注入 autoCompactTracking + projectInstructions
│                              + chatRuntime 给 slash dispatch
├── renderAgentEvent.ts       新增 compact_start / compact_end 渲染分支
├── ChatCommand.ts            启动时 getProjectInstructions 一次
└── slash/
    ├── compact.ts            /compact 斜杠命令
    ├── compact.test.ts
    ├── types.ts              SlashContext +chatRuntime 字段
    └── registry.ts           +compactCommand

src/commands/AskCommand/runAskWithLLM.ts   注入同 chat 同款 + 渲染 compact 事件
```

---

## 3. AgentEvent 扩展

```ts
| { type: "compact_start"; trigger: "auto"|"manual"; preCompactTokenCount: number }
| { type: "compact_end"; trigger; preCompactTokenCount; postCompactTokenCount?; error? }
```

`renderAgentEvent` 把这两类事件渲染成单行 `[compact] auto-compacting (≈ X tokens)` /
`[compact] done: X → Y tokens` 的 stderr 输出，与 `[tool]` / `[permission]` 风格一致。

---

## 4. 与 claude-code 的差异（显式声明）

| 维度 | claude-code | nova-code M4 | 理由 |
|---|---|---|---|
| 文件数 | 11 个 services/compact + 2 个 commands/compact | 7 个 + 1 个 | 不实现 reactiveCompact / sessionMemory / microcompact / postCompactCleanup / compactWarningHook —— 这些是 prompt cache 优化与 1M context 实验，M4 范畴外 |
| forked agent | compact 走独立子 agent 复用 prompt cache：带主循环同款 system/tools，并用 `tool_choice:none` 禁工具调用 | **同款实现**：auto compact 与手动 `/compact` 都把主循环 system/tools 透给 compact 请求，并设置 `tool_choice:none` | 保持 prompt cache key 对齐；`NO_TOOLS_PREAMBLE` 是软约束，`tool_choice:none` 是硬约束 |
| token 计数 | `tokenCountWithEstimation` + message 内嵌完整 SDK Usage 字段（含 cache 4 项），从末尾 walk-back 找最近 usage | **同款实现**：`NovaMessage.usage?: ApiUsage` 挂在 assistant message 上；`tokenCountWithEstimation(messages)` 从末尾找最近 usage，再对之后 messages 做 chars/4 | token 锚点随 messages 持久化，不需要额外 tracking side-channel；旧 session 缺 usage 时安全降级为全量 chars/4 |
| @include 解析 | marked lexer + frontmatter + html comment strip + claudeMdExcludes settings | **同款 marked lexer + html comment strip + TEXT_FILE_EXTENSIONS 白名单 + 完整 isValidPath 校验**；不解析 frontmatter `paths` glob 与 claudeMdExcludes settings | M4 落地核心；frontmatter glob 与 settings 等留到 M9 Skills 统一引入 |
| growthbook gating | 全程 feature flag | 无 | nova-code 无实验框架 |
| Telemetry / logEvent | 两层架构（`index.ts` 门面 + `sink.ts` 实际投递）+ Datadog / 1P fanout | **同款两层架构**：`index.ts` 门面零依赖、单一 sink、attach 前 eventQueue + queueMicrotask 异步排空 + 幂等 `attachAnalyticsSink`；`sink.ts` 默认实现：环形 buffer (256 条) + 可选 JSONL 落盘（`NOVA_TELEMETRY_FILE`）+ `NOVA_DISABLE_TELEMETRY=1` 开关；同时支持 `logEvent` / `logEventAsync` 双接口 | nova-code 不接外部分析平台但保留两层骨架，M9+ 接 Datadog / OTEL 时只需实现 `AnalyticsSink` 接口；事件名沿用 tengu_ 前缀 |
| Pre/Post Compact hooks | 用户脚本 hook | 无 | hooks 系统是 M10 范畴 |
| 文件位置 | utils/claudemd.ts / utils/tokens.ts / services/analytics/index.ts | services/projectInstructions/claudeMd.ts / services/compact/tokens.ts / services/analytics/index.ts | nova-code §7.1 禁 utils/ 大杂烩，按"文件即域"放 services |
| Circuit breaker 阈值 | MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 | 同款 = 3 | 直接复刻 |
| 埋点事件清单 | 数百条 `tengu_*` 事件 | M4 落地时同步把 M0–M3 模块的关键埋点也补齐：API 层（`tengu_api_query` / `tengu_api_success` / `tengu_api_error` / `tengu_api_retry`）、Bash（`tengu_bash_security_check_triggered` / `tengu_bash_tool_command_executed`）、Session/Slash（`tengu_session_file_read` / `tengu_input_slash_invalid` / `tengu_input_slash_missing`）、权限（`tengu_internal_record_permission_context` / `tengu_permission_request_option_selected`）、CLI 生命周期（`tengu_started` / `tengu_exit`）、M4 自身（`tengu_compact*` / `tengu_autocompact*` / `tengu_claude_md_*`）。完整清单见 `docs/architecture/M4/overview.md §6` | 跨参考定位 |

---

## 5. 向后兼容

### 5.1 AgentLoopParams 新增字段全部可选

`autoCompactEnabled` / `autoCompactTracking` / `projectInstructions` 都不传时，主循环行为与 M3 完全一致（无自动 compact、无 CLAUDE.md 注入）。M3 既有单测 0 改动通过。

### 5.2 sessionStore JSONL 不需迁移

NovaMessage 形态不变 → M2 之前保存的会话文件加载后行为完全一致。compact 之后产生的新 messages（一条 user-role + summary 文本）也是合法的 NovaMessage，sessionStore 直接序列化即可。

### 5.3 chat / ask 命令的默认行为

| 命令 | autoCompactEnabled | projectInstructions | trigger |
|---|---|---|---|
| `nova-code chat` | true（默认） | 启动时一次性加载，拼到 system prompt | auto |
| `nova-code ask` | true | 同上 | auto |
| 单测 / lib 调用 | 不传则关闭 | 不传则不注入 | — |

---

## 6. 测试覆盖范围

| 模块 | 单测 | 关键边界 |
|---|---|---|
| contextWindow | 4 | 阈值算式正确、未知模型回落默认 |
| tokens | 14 | walk-back-from-end、cache 字段为 null、空数组、无 usage 降级 |
| prompt | 12 | strip `<analysis>`、format `<summary>` → "Summary:" header、suppress flag |
| compact 主路径 | 10 | 空 messages / 空响应 / abort / customInstructions / max_tokens / forked-agent tools + `tool_choice:none` / log sink |
| partialCompact | 5 | keepRecent 不足 / 切片正确 / prefix 进请求 / 默认值 / 入参校验 |
| autoCompact | 12 | enabled false / 空 messages / 阈值上下边界 / circuit breaker 3 次 |
| projectInstructions | 18 | 4 层加载顺序 / @include 递归 / 循环检测 / 平台跳过 / fenced code block 跳过 / inline @path / inline code 跳过 / fragment 剥离 / escaped space |
| analytics 门面 (index) | 9 | attach 前 enqueue / queueMicrotask 异步排空 / 幂等 / sync vs async / 抛错容错 |
| analytics 默认 sink | 11 | ringBuffer 顺序 + 环形覆盖 / NOVA_DISABLE_TELEMETRY noop / NOVA_TELEMETRY_FILE 串行写 / async 路径 await 已落盘 |
| ChatSession.compact | 4 | 空抛错 / 成功重置 / 失败原子性 / customInstructions 透传 |
| /compact 斜杠 | 4 | chatRuntime 缺失 / 成功打印 / 错误打印 / args 拼接 |
| renderAgentEvent | 5 | auto / manual / 成功 / 失败 / inAssistantText 补换行 |
| **m4-e2e-compact** | 4 | 自动触发 / /compact 手动 / 50 轮不超限 / CLAUDE.md + @include 注入到 system |

合计新增 ~105 条单测 + 4 条 e2e。

---

## 7. 后续预留

M4 故意没做、留给后续 milestone：

- **partialCompact 自动切换**：当 main compact 后用户报告"模型遗忘严重"，需要 `config.compactStrategy = "partial"` 或自动切。M4 仅落地两条路径，自动切换的判定逻辑留给 M6.5 或自用反馈。
- **session-memory compact / reactive compact**：claude-code 的两套高级 compact，依赖 forked agent + prompt cache。Phase 2 的 M11 AgentTool 落地后再考虑。
- **micro compact**：清理旧 tool_result 而非整段 summary，是 prompt cache 优化。Phase 2 性能调优阶段补。
- **post-compact hook**：M10 hooks 系统统一引入。
- **frontmatter `paths` glob**：CLAUDE.md 按文件路径 scope 应用规则，需要 picomatch 等 glob 库。Skills 系统（M9）会提供更结构化的方案。
- **CLAUDE.md HTML 注释剥离**：与 marked lexer 一起留到 M9。

---

## 8. 跨文档引用

- 使用手册：[`docs/manual/M4-usage-guide.md`](../manual/M4-usage-guide.md)
- 实现架构：[`docs/architecture/M4/README.md`](../architecture/M4/README.md)
- 上游 milestone 设计稿：
  - M3 权限：[`docs/design/M3-permissions.md`](./M3-permissions.md)
  - M2 chat REPL：[`docs/design/M2-chat-repl.md`](./M2-chat-repl.md)
  - M1.5 重构：[`docs/design/M1.5-refactor.md`](./M1.5-refactor.md)
- 路线图：[`docs/roadmap.md`](../roadmap.md) v2.5（M4 完成）
