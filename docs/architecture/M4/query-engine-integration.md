# QueryEngine 与 M4 的集成点

## 1. AgentLoopParams 三个新字段

```ts
interface AgentLoopParams {
  // ... 既有字段（M3）...

  // M4：全部可选；不传时主循环行为与 M3 完全一致
  readonly autoCompactEnabled?: boolean;             // 默认 false（不传即关闭）
  readonly autoCompactTracking?: AutoCompactTrackingState;
  readonly projectInstructions?: string;
}
```

设计选择：默认关闭，让 M3 既有 67 条单测 0 改动通过。chat / ask 命令在调用 runAgentLoop 时显式 `autoCompactEnabled: true` + 注入 tracking。

## 2. systemPrompt 拼接

`runAgentLoop` 入口处：

```ts
const systemPrompt = buildSystemPrompt({
  ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
  ...(params.projectInstructions !== undefined
    ? { projectInstructions: params.projectInstructions }
    : {}),
});
```

只在 projectInstructions 非空白时才拼接，避免对纯空字符串多塞两个换行。
`buildSystemPrompt` 同时给手动 `/compact` 复用，确保 compact forked-agent 请求与主循环使用同一个 system 文本。

## 3. 主循环里的 tryAutoCompact 调用

每轮 turn 开头（`signal.aborted` 检查之后、`yield turn_start` 之前）：

```ts
for (let turn = 1; turn <= config.maxTurns; turn += 1) {
  if (signal.aborted) throw new AbortError();

  // ── M4 插桩点 ──────────────────────────────────
  if (params.autoCompactEnabled === true && params.autoCompactTracking !== undefined) {
    const outcome = yield* tryAutoCompact({
      messages, client, model: config.model,
      tracking: params.autoCompactTracking,
      signal,
      llmLogSink: params.llmLogSink,
      systemPrompt,
      sdkTools,
    });
    if (outcome.replaced) {
      messages.length = 0;                   // 原子清空
      messages.push(outcome.summaryMessage); // 替换为单条 summary
    }
  }
  // ───────────────────────────────────────────────

  yield { type: "turn_start", turn };

  const { assistantMessage, stopReason } = yield* streamOneTurn({...});
  messages.push(assistantMessage);

  // ── M4 usage 锚点更新 ───────────────────────────
  // streamOneTurn 已把 final.usage 挂到 assistantMessage.usage 上。
  if (params.autoCompactTracking !== undefined) {
    params.autoCompactTracking.turnCounter += 1;
  }
  // ───────────────────────────────────────────────

  // ... 原 M3 流程：yield turn_end / 工具执行 / 推 tool_results ...
}
```

### 3.1 为什么放在 `streamOneTurn` 之前

- 阈值判定基于"最近一条 assistant message 的 usage + 之后新增的 messages"，必须在新一轮 LLM 调用之前判
- 若放后面，本轮请求可能已经因 messages 太长被服务端拒绝，compact 就晚了

### 3.2 为什么 messages 用 `length = 0; push(...)` 而非 `messages = [...]`

`messages` 在 runAgentLoop 顶部用 `const messages: NovaMessage[] = [...]` 声明 —— 是常量绑定，不能重赋值。但内容可变。`length = 0; push()` 是原地清空 + push 的常用模式，行为等价于赋新数组。

## 4. tryAutoCompact helper

**位置**：`src/QueryEngine.ts` 文件末尾

```ts
async function* tryAutoCompact(params: TryAutoCompactParams):
  AsyncGenerator<AgentEvent, TryAutoCompactOutcome, void>
{
  // 同步预判：阈值未到 / breaker 触发 → 静默返回，不发 compact_start
  if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { replaced: false };
  }
  if (!shouldAutoCompact({...})) return { replaced: false };

  const preCount = tokenCountWithEstimation(messages);
  yield { type: "compact_start", trigger: "auto", preCompactTokenCount: preCount };

  const outcome = await autoCompactIfNeeded({...});

  yield {
    type: "compact_end",
    trigger: "auto",
    preCompactTokenCount: outcome.preCompactTokenCount ?? preCount,
    ...(outcome.postCompactTokenCount !== undefined ? { postCompactTokenCount: ... } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  };

  if (outcome.wasCompacted && outcome.summaryMessage !== undefined) {
    return { replaced: true, summaryMessage: outcome.summaryMessage };
  }
  return { replaced: false };
}
```

设计要点：
- "同步预判" + "yield compact_start" 顺序保证：UI 看到 compact_start 时一定要看到 compact_end，不会出现孤立的 start 事件
- 失败路径也 yield compact_end，把 error 字段填上 → renderAgentEvent 能渲染失败提示
- 返回值 union 类型 `{ replaced: true, summaryMessage } | { replaced: false }` 让调用方用类型守卫安全收窄

## 5. ChatSession 透传

`ChatSession.sendTurn` 把 ChatTurnContext 上的三个 M4 字段透传给 runAgentLoop：

```ts
const gen = agentLoop({
  // ... 既有字段 ...
  ...(ctx.autoCompactEnabled !== undefined ? { autoCompactEnabled: ctx.autoCompactEnabled } : {}),
  ...(ctx.autoCompactTracking !== undefined ? { autoCompactTracking: ctx.autoCompactTracking } : {}),
  ...(ctx.projectInstructions !== undefined ? { projectInstructions: ctx.projectInstructions } : {}),
});
```

ChatTurnContext 上对应新增的可选字段：

```ts
interface ChatTurnContext {
  // ... M3 字段 ...
  readonly autoCompactEnabled?: boolean;
  readonly autoCompactTracking?: AutoCompactTrackingState;
  readonly projectInstructions?: string;
}
```

## 6. ChatSession.compact()：手动路径

**位置**：`src/commands/ChatCommand/ChatSession.ts`

```ts
async compact(ctx: ChatCompactContext, customInstructions?: string): Promise<ChatCompactOutcome> {
  if (this.messages.length === 0) throw new Error("No messages to compact yet.");

  const client = (ctx.clientFactory ?? createAnthropicClient)(ctx.config);
  const snapshot = this.messages;  // 快照

  const result = await compactConversation({
    messages: snapshot,
    client,
    model: ctx.config.model,
    trigger: "manual",
    ...(customInstructions !== undefined ? { customInstructions } : {}),
    signal: ctx.signal,
    ...(ctx.llmLogSink !== undefined ? { llmLogSink: ctx.llmLogSink } : {}),
    ...(ctx.systemPrompt !== undefined || ctx.projectInstructions !== undefined
      ? { systemPrompt: buildSystemPrompt({ ... }) }
      : {}),
    ...(ctx.tools !== undefined ? { sdkTools: ctx.tools.map(toSdkTool) } : {}),
  });

  // 原子提交：成功才动 this.messages
  this.messages = [result.summaryMessage];
  return { preCompactTokenCount, postCompactTokenCount, compactedMessages: snapshot.length };
}
```

设计要点：
- **快照 + 成功才提交**：与 sendTurn 同模式 —— 中途抛错（abort / LLM error / 不足消息）则 `this.messages` 保持不变
- **不接完整 ChatTurnContext**：compact 不需要权限；但会复用主循环 system/tools，让 forked-agent compact 请求与主会话共享 prompt cache
- **trigger: "manual"**：summary 文本不附 "Continue the conversation" —— 让用户能审视

## 7. /compact 斜杠命令路径

```
用户输入 "/compact focus on tests"
  │
  ▼ runChatRepl 主循环
  ├─ 创建 slashAbort = new AbortController()
  ├─ phaseRef = streaming(slashAbort)         ← Ctrl+C 能中断
  ├─ dispatchSlash("/compact focus on tests", { chatRuntime: { config, signal, llmLogSink, systemPrompt, tools } })
  │    └─ findSlashCommand("compact") → compactCommand.run(ctx)
  │         └─ session.compact({config, signal, llmLogSink, systemPrompt, tools}, "focus on tests")
  │              └─ compactConversation({trigger: "manual", system/tools, tool_choice:none, ...})
  └─ phaseRef = idle
```

`SlashContext` 增加 `chatRuntime?` 字段携带 `{ config, signal, llmLogSink?, systemPrompt?, tools? }`，让 /compact 这类需要发 LLM 调用的命令也能拿到运行时上下文。其它斜杠命令（/clear / /save / /load / /exit / /permissions）不读这个字段。

## 8. 渲染层

`renderAgentEvent` 新增分支处理 `compact_start` / `compact_end`，输出形如：

```
[compact] auto-compacting (≈ 168432 tokens)
[compact] done: 168432 → 612 tokens
```

或失败：

```
[compact] failed: <error message>
```

`runAskWithLLM` 在自己的 switch 里也加了对应分支（M3 风格保持一致 —— ask 不用 renderAgentEvent，而是内联 switch）。

## 9. 边界与陷阱

| 场景 | 行为 |
|---|---|
| compact 触发但 messages 已被 sendTurn 间歇 mutation | 不会发生：runAgentLoop 内部唯一持有 messages 数组，且 tryAutoCompact 是同步 yield 闭包内执行 |
| compact 后下一轮 streamOneTurn 报错 | 报错正常上抛；下一轮没有新的 assistant usage，token 计数会从 summary 文本粗估 |
| /compact 与自动 compact 同时发生 | runChatRepl 用 phaseRef 串行化所有 LLM 调用 —— 同一时刻只可能有一个 sendTurn 或 dispatchSlash 在跑，不会重入 |
| 手动 /compact 抛错 | compactCommand 捕获并打印 `/compact 失败: <msg>`，REPL 不退出 |
| autoCompact LLM 调用超时 | SDK 自带 timeout（10 分钟）；超时抛 → autoCompactIfNeeded catch → consecutiveFailures += 1 |
| compact 后 messages 仅含 summary，下轮 streamOneTurn 没有"实际新 user prompt" | 这是预期行为：summary 文本本身就是一条 user-role message，模型据此继续对话。runAgentLoop 不会在 messages 上额外追加新 user（userPrompt 已经在 messages 里了，被 compact 替换） |

实际上最后一条有微妙之处：当 compact 触发时机是"用户刚发了新 q5"，messages 长这样：
```
[ ...历史..., user "q5" ]
```
compact 后变成：
```
[ summaryUserMessage ]   ← summary 内容包含 q5 之前的历史 + 隐含 "Continue the conversation"
```
但 `q5` 本身被 summary 进去了，模型不会"忘记" q5（在 summary 的 "Current Work" 段）。下一轮 LLM 看到这条 summary 即可继续工作。
