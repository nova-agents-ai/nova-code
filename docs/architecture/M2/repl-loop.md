# REPL 主循环（runChatRepl）

对应源文件：[runChatRepl.ts](../../../src/commands/ChatCommand/runChatRepl.ts) +
[renderAgentEvent.ts](../../../src/commands/ChatCommand/renderAgentEvent.ts)。

本文件解释 M2 的交互引擎如何把 `readline` 的按行输入、SIGINT
信号、斜杠命令、`ChatSession.sendTurn` 的事件流拼成一个可用的聊天 REPL。

---

## 1. 职责边界

runChatRepl 专注于「I/O + 状态机 + 分发」，具体而言只做 4 件事：

1. 用 `node:readline/promises` 按行读取用户输入
2. 把每一行先交给 [dispatchSlash](../../../src/commands/ChatCommand/slash/dispatcher.ts) —— 识别斜杠命令；非斜杠再交给 `session.sendTurn`
3. 消费 AgentEvent 流 → 同时喂给 debugSink 和 renderAgentEvent
4. 管理 SIGINT 三态状态机（idle / streaming / pending-exit）

它**不做**：

- 不自己构造 ChatSession（由 [ChatCommand](../../../src/commands/ChatCommand/ChatCommand.ts) 传入）
- 不维护对话历史（历史在 ChatSession 内部，REPL 只是消费事件）
- 不做具体事件渲染（全部委托 renderAgentEvent）
- 不决定"什么算斜杠命令" —— 只要前缀是 `/` 就交给 dispatcher

这四条边界让 runChatRepl 的控制流纯粹，错误也更好定位。

---

## 2. 参数契约（RunChatReplParams）

```ts
interface RunChatReplParams {
  readonly session: ChatSession;
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  readonly debugSink: DebugSink;             // AgentEvent 全量日志
  readonly llmLogSink?: DebugSink;           // 原始 LLM 请求/响应日志（可选）
  readonly configSource?: ConfigSource;      // 注入 home 目录，给 /save /load 测试用
  readonly io?: ReplIO;                      // 注入 I/O，替代 process.stdout/stderr
}
```

依赖注入点全部都是**可选**的：
- `io`：生产路径用 `defaultReplIO()` 包 `process.stdout/stderr`；测试可以塞一个记录型 io 断言输出
- `llmLogSink`：未开 --debug 时上层传 `undefined`；REPL 不自己创建，只负责原样转发给 `session.sendTurn`
- `configSource`：用来把 ~/.nova-code 目录重定向到 tmp，保持单测隔离

---

## 3. 一次输入的完整处理

```
┌──────────────────────────────────────────────────────────────────────┐
│  while (true) {                                                       │
│    line = await readLine("> ")                                        │
│    if (line === null) return 0          ← EOF / rl.close              │
│    input = line.trim()                                                │
│    if (input === "") continue           ← 空行不做任何事              │
│                                                                       │
│    // pending-exit 窗口在「有实际输入」时才清掉                       │
│    clearPendingExitIfAny()                                            │
│                                                                       │
│    // 斜杠命令                                                        │
│    dispatch = await dispatchSlash(input, { session, io: slashIO })    │
│    if (dispatch.handled) {                                            │
│      if (result.action === "exit") return result.exitCode             │
│      continue                                                         │
│    }                                                                  │
│                                                                       │
│    // 真实对话：agent loop                                            │
│    abort = new AbortController()                                      │
│    phase = { kind: "streaming", abort }                               │
│    try {                                                              │
│      for await (event of session.sendTurn(input, { ..., signal })) {  │
│        debugSink.write(event)                                         │
│        renderAgentEvent(event, io, renderState)                       │
│      }                                                                │
│    } catch (error) { handleTurnError(error, io) }                     │
│    finally { phase = { kind: "idle" } }                               │
│  }                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

几个容易踩坑的细节：

### 3.1 为什么用 asyncIterator 而不是 `rl.question()`

`readline/promises` 的 `question()` 底层监听 `once("line")`；
若 stdin 是 pipe 且「没被监听就已到达多行」，中间那些 line 事件会丢掉。
asyncIterator 内部维护一个队列，每次 `next()` 总能取到下一行，是 pipe 输入场景下唯一可靠的读法。

```ts
const lineIterator = rl[Symbol.asyncIterator]();
const readLine = async (prompt) => {
  io.stdout(prompt);
  const { value, done } = await lineIterator.next();
  return done ? null : value;
};
```

### 3.2 为什么 prompt 写 `io.stdout` 而不是 `process.stdout`

让测试可以用同一个 `io` 捕获「提示符 + 输出 + 错误」三类文本。生产路径的
`defaultReplIO()` 只是一层 `process.stdout.write` 透传，代价为零。

### 3.3 空行为何不清 pending-exit

设计稿约定：pending-exit 窗口只有在**用户做出真实动作**（输入命令/问题）或
**1.5s 超时**时才结束。空行按回车是用户下意识动作，不视为意图表达，不重置窗口。

---

## 4. SIGINT 状态机

### 4.1 三个状态

| kind | 含义 | 下一次 Ctrl+C 的行为 |
|------|------|----------------------|
| `idle` | 等用户输入 | 进入 `pending-exit`，弹提示 |
| `streaming` | agent loop 正在跑 | 调 `abort.abort()`，终止当前 turn |
| `pending-exit` | 1.5s 退出窗口中 | 立刻 `process.exit(130)` |

`PENDING_EXIT_WINDOW_MS = 1500` 常量就位于 runChatRepl.ts 顶部，和设计稿 §8 一致。

### 4.2 用 ref 对象包 phase 的原因

```ts
const phaseRef: { current: SigintPhase } = { current: { kind: "idle" } };
```

TypeScript 的控制流分析（CFA）对局部 `let` 很激进，但对「对象属性」故意保守
——在循环外设置 `phase = { kind: "idle" }`，循环内 switch 的 `case "pending-exit"` 会被误判为永假。
包成 ref 对象后属性类型保持 union，避免这种死代码消除。

### 4.3 SIGINT 双路注册

SIGINT 的派发路径与 stdin 是否 TTY 有关：

```
TTY 模式：  Ctrl+C ─► readline 捕获 ─► rl.emit("SIGINT")
                                       │
                                       └─► processSigintHandler ✓

非 TTY：    Ctrl+C ─► Node 默认 ─► process.emit("SIGINT")
                                    │
                                    └─► processSigintHandler ✓
```

代码同时 `rl.on("SIGINT", h)` 和 `process.on("SIGINT", h)`：
每次 Ctrl+C 只会命中其中一条路径，不会重入，同一个 handler 覆盖两种场景。

### 4.4 streaming → idle 的切换点

```ts
try {
  for await (const event of session.sendTurn(...)) { ... }
} catch (error) { handleTurnError(error, io) }
finally {
  phaseRef.current = { kind: "idle" };  // ← 这里
}
```

不在 `processSigintHandler` 的 `case "streaming"` 里改 phase，因为那样
会和 finally 里的赋值产生竞态（并发 SIGINT + 流正常结束）。让 finally 统一收尾，handler 只做 abort。

---

## 5. 事件渲染（renderAgentEvent）

该函数是纯函数：`(event, io, state) => void`。共享给 ask 与 chat 两个入口
（参照 `src/commands/AskCommand/runAskWithLLM.ts` 中 M1.5 的 switch 分支，行为等价）。

### 5.1 事件 → 输出映射

| 事件 | 输出 |
|------|------|
| `turn_start` (turn>1) | stderr 一个 `\n`（把上轮 tool 输出与新段正文分开） |
| `text_delta` | stdout 直出 delta，并置 `state.inAssistantText = true` |
| `tool_call` | 若刚写过正文先补 `\n`；再写 stderr `[tool] name {json}` |
| `tool_result` | **仅在 isError=true 时**写 stderr 一行失败提示 |
| `done` | stdout 写末尾 `\n`，重置 `inAssistantText` |
| `turn_end` | 不渲染（assistant 完整消息已在 debug sink / session 内） |

### 5.2 为什么 RenderState 只有 `inAssistantText` 一位

`text_delta` 和 `tool_call` 可能在同一 turn 内交错出现，renderer 需要知道
「上一条是不是正文」才能决定是否补换行。其他事件不依赖跨事件状态。
把 state 显式化成一个小对象比闭包更利于测试（断言 before/after 都方便）。

### 5.3 tool_result 为什么默认静默

失败才打（且只一行 message）。成功 tool_result 内容可能很大（比如 Read
整个文件），塞到 stderr 会淹没对话。完整事件流仍进 debug sink，排查问题去翻 log。

---

## 6. 错误映射

`handleTurnError` 把 sendTurn 抛的错 **本轮消化**，REPL 不退出：

```ts
if (error instanceof AbortError) {
  io.stderr("\n[cancelled]\n");
  return;
}
io.stderr(`\n[error] ${message}\n`);
```

设计意图：

- **AbortError** 是用户主动 Ctrl+C，当作正常状态转换，不算「错误」
- 其他异常（API 错误、ToolExecutionError 等）只摘 message 给用户看；
  想看堆栈走 --debug 日志
- 不 rethrow 意味着主循环继续，用户可以接着输入

REPL 真正退出的场景只有三种：
- `readLine` 返回 null（EOF / rl.close）→ return 0
- dispatcher 返回 `action: "exit"` → return exitCode
- SIGINT 双按 → `process.exit(130)` （硬退，不过 finally）

---

## 7. 为什么 REPL 本身不做单测

runChatRepl 内部纯控制流，没有可被独立验证的领域逻辑：
- 每条分支的行为 = dispatcher / ChatSession / renderAgentEvent 各自已覆盖的行为
- readline 与 TTY/SIGINT 的互动最小化复现需要子进程 + 真实 pty，这属于 e2e 层

M2 的测试策略是「三块高内聚组件各自单测充分」+「e2e 覆盖集成」：
- [ChatSession.test.ts](../../../src/commands/ChatCommand/ChatSession.test.ts) 覆盖事件重建 + 原子提交
- [dispatcher.test.ts](../../../src/commands/ChatCommand/slash/dispatcher.test.ts) 覆盖斜杠命令解析
- [renderAgentEvent.test.ts](../../../src/commands/ChatCommand/renderAgentEvent.test.ts) 覆盖事件到 I/O 的映射
- runChatRepl 由 bun e2e 覆盖（Task 10，跨子进程）

---

## 8. 下一步

- 斜杠命令体系详见 [slash-commands.md](./slash-commands.md)
- ChatSession 内部原子提交细节见 [chat-session.md](./chat-session.md)
- LLM 日志如何串起来见 [llm-debug-log.md](./llm-debug-log.md)
