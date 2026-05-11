# 01 · Overview —— M2 全局鸟瞰

> 先读本篇获得 M2 子系统的全局观，再按需跳读其他文档。已熟悉 M1.5 的读者可直接看 §2 起的"增量"部分。

## 1. 一张图看懂 chat 子系统

```
┌──────────────────────────────────────────────────────────────────┐
│                    bin/nova-code.ts → src/cli.ts                 │
│                       findCommand("chat")                         │
└───────────────────────────────┬──────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│            src/commands/ChatCommand/ChatCommand.ts               │
│  - parseChatFlags   解析 --debug / --debug-pretty / --resume     │
│  - loadConfig       复用 M1.5 配置层                             │
│  - newSession / resumeSession (sessionStore)                     │
│  - 创建两个 debugSink（"chat" + "chat-llm"）                     │
│  - runChatRepl(...)                                              │
└───┬──────────────────────────────────────────────────────────┬───┘
    │                                                          │
    │ session (ChatSession)                                    │ debugSink × 2
    ↓                                                          ↓
┌──────────────────────────────────────────────────────────────────┐
│           src/commands/ChatCommand/runChatRepl.ts                │
│  - readline AsyncIterator                                        │
│  - SIGINT 三态状态机：idle / streaming / pending-exit            │
│  - 主循环：readLine → dispatchSlash → session.sendTurn           │
│  - renderAgentEvent 把事件转成 stdout/stderr                     │
└───┬───────────────────┬────────────────────────────────────┬─────┘
    │                   │                                    │
    ↓                   ↓                                    ↓
┌──────────┐   ┌────────────────────┐          ┌─────────────────────────┐
│ slash/   │   │ ChatSession        │          │ renderAgentEvent        │
│ dispatch │   │  sendTurn(原子提交)│          │   （stdout = 正文       │
│ + 5 命令 │   │  clear/snapshot/   │          │    stderr = 工具/分隔） │
└────┬─────┘   │  restore           │          └─────────────────────────┘
     │         └──────────┬─────────┘
     │                    │
     ↓                    ↓
┌─────────────┐   ┌──────────────────────────────────────────────┐
│sessionStore │   │            src/QueryEngine.ts                │
│ JSONL 读写  │   │  runAgentLoop（M2 新增 initialMessages）     │
│ kind: meta  │   │  streamOneTurn 写 LlmLogSink 三事件          │
│ /msg        │   │    llm_request / llm_response / llm_error    │
└─────────────┘   └──────────────────────────────────────────────┘
```

## 2. src/ 目录增量（相对 M1.5）

```
src/
├── commands/
│   ├── AskCommand/              （M1.5 已有；M2 内部新增 llmLogSink 创建）
│   │   ├── debugSink.ts             prefix / sessionId 参数 M2 扩展
│   │   ├── runAskWithLLM.ts         新增 ask-llm sink 并传给 runAgentLoop
│   │   └── ...
│   │
│   └── ChatCommand/             ★ M2 全新子目录
│       ├── ChatCommand.ts           命令入口：flag 解析、配置加载、sink 创建、runChatRepl 启动
│       ├── parseChatFlags.ts        --debug / --debug-pretty / --resume
│       ├── sessionId.ts             ISO 秒 + 4B 随机 hex 组合
│       ├── sessionStore.ts          JSONL 读写（save/load）+ assertSafeFileName
│       ├── ChatSession.ts           多轮对话状态容器 + 原子 sendTurn
│       ├── renderAgentEvent.ts      纯函数渲染（ask/chat 共享）
│       ├── runChatRepl.ts           REPL 主循环 + SIGINT 状态机
│       │
│       └── slash/                   ★ 斜杠命令体系
│           ├── types.ts                 SlashCommand / SlashContext / SlashIO / SlashResult
│           ├── dispatcher.ts            解析一行输入 → 执行 SlashCommand
│           ├── registry.ts              5 条内置命令聚合 + 按名查找
│           ├── clear.ts                 /clear
│           ├── exit.ts                  /exit
│           ├── save.ts                  /save [alias]
│           ├── load.ts                  /load <idOrAlias>
│           └── help.ts                  /help（工厂函数，注入 registry 避循环）
│
├── QueryEngine.ts               M2 新增 LlmLogSink 接口 + initialMessages 参数
│                                    + streamOneTurn 写 llm_request/response/error
│
├── types/message.ts             M2 未改动（现有结构已够用）
└── ...（其余目录 M1.5 状态不变）
```

## 3. 分层依赖（M2 增量）

```
                      cli.ts
                        │
             ┌──────────┼──────────────────────────────┐
             ↓          ↓                              ↓
       commands/*   commands.ts                   (top-level)
             │          │
       ┌─────┴──┐       │
       ↓        ↓       │
    AskCmd   ChatCmd    │                 ←── M2 新子目录
             ↓          │
       ┌─────┴───────┐  │
       ↓             ↓  │
   ChatSession    slash/─ (registry / dispatcher / 5 命令)
       │             │
       └──→ sessionStore ──→ config/ (getSessionsDirPath)
       │
       ↓
    QueryEngine.ts ─→（同 M1.5：services/api/ tools.ts config/ errors/ types/）
```

**新增强制规则**：

- `ChatCommand/slash/*` 只依赖 `sessionStore.ts` + `ChatSession.ts` + 同目录 types。**不依赖 `runChatRepl.ts`**（避免循环），通过 `SlashContext` 的注入拿到 session 句柄。
- `ChatCommand/sessionStore.ts` 依赖 `config/` 的 `getSessionsDirPath(source)` 和 `types/message.ts` 的 `NovaMessage`，**不直接 import QueryEngine**。
- `ChatCommand/ChatSession.ts` 依赖 `QueryEngine.ts`（import `runAgentLoop` + `LlmLogSink`）。**反向不成立**：QueryEngine 不 import ChatSession。
- `slash/help.ts` 不 import `slash/registry.ts`（循环）——通过工厂函数 `makeHelpCommand(() => builtinSlashCommands)` 让 registry 把自身数组通过闭包注入。

## 4. 一次 `nova-code chat` 的端到端时序

```
用户 shell
  └─ bin/nova-code.ts
       └─ runCli({...}) → findCommand("chat") → chatCommand.run(rest)
           └─ src/commands/ChatCommand/ChatCommand.ts
               ├─ parseChatFlags(rest)            // {debug, pretty, resumeId}
               ├─ loadConfig()                    // 同 M1.5
               ├─ newSession(config.model)         // or resumeSession(resumeId)
               │   └─ generateSessionId()           // 2026-05-04T16-58-32-a1b2c3d4
               ├─ createFileDebugSink × 2            // "chat" / "chat-llm"
               └─ runChatRepl({session, config, tools, debugSink, llmLogSink, ...})
                   ├─ createInterface(readline)
                   ├─ 注册 SIGINT（rl + process 双路）
                   ├─ 打印 Welcome 到 stderr
                   │
                   └─ while (true):
                        ├─ readLine("> ")                // 等用户输入
                        ├─ line === null                  // EOF/Ctrl+D → return 0
                        │
                        ├─ 若 input.startsWith("/")：
                        │   └─ dispatchSlash(input, ctx)
                        │       └─ findSlashCommand(name)
                        │           └─ cmd.run({session, io, args, configSource?})
                        │               ├─ /clear  → session.clear()
                        │               ├─ /exit   → return {action:"exit", exitCode:0}
                        │               ├─ /save   → saveSession(...)
                        │               ├─ /load   → loadSession + session.restore
                        │               └─ /help   → io.print(命令列表)
                        │
                        └─ 非斜杠：session.sendTurn(input, ctx)
                            ├─ const initialMessages = [...this.messages]   ← 快照
                            ├─ const newMessages = [...messages, {role:user, content:input}]
                            ├─ gen = runAgentLoop({
                            │    config, userPrompt:input, initialMessages,
                            │    tools, signal, llmLogSink?:...
                            │  })
                            ├─ for await (event of gen):
                            │   ├─ turn_start  → pending flush 成 user(tool_result)
                            │   ├─ turn_end    → newMessages.push(assistant msg)
                            │   ├─ tool_result → pending.push(block)
                            │   ├─ text_delta / tool_call / done → 仅转发
                            │   └─ 同时 debugSink.write(event) + renderAgentEvent(event, io, state)
                            └─ 所有事件消费完 → this.messages = newMessages    ← 原子提交
                               （中途抛错则 this.messages 保持不变，rollback）

finally:
  - rl.close()
  - removeListener("SIGINT", ...)
  - debugSink.close() + llmLogSink.close()
```

## 5. AgentEvent → ChatSession 的重建映射

`runAgentLoop` 内部维护自己的 messages 数组，对外只暴露事件。`ChatSession` 通过订阅事件流"重建"一份等价的历史。映射规则必须与 `QueryEngine.ts` 内部 push 顺序严格对齐：

| AgentEvent | 对 ChatSession 内部 `newMessages` 的影响 | 说明 |
|---|---|---|
| `turn_start` | 若 `pending` 非空：flush 成 `{role:user, content:[tool_result...]}` 追加到 newMessages | 模型要回信前把上一批 tool_result 打包——此时机与 QueryEngine 内部 `messages.push({role:USER, content:toolResults})` 位置完全一致 |
| `text_delta` | —— | 纯转发给 renderer，不影响历史 |
| `turn_end` | `newMessages.push(event.message)`（assistant 消息） | SDK finalMessage 已转换为 NovaMessage |
| `tool_call` | —— | 仅转发（tool_use 已在 assistant message 内被 push 过了） |
| `tool_result` | `pending.push(ToolResultBlock{tool_use_id, content, is_error?})` | 累积到下一个 `turn_start` 才 flush |
| `done` | —— | generator 结束标记；其后 `this.messages = newMessages` |

这个表就是 ChatSession 源码的 switch 分支；背下来即可随手验证任何状态异常问题。

## 6. SIGINT 三态状态机

```
                  ┌──────────────────────────┐
                  │         idle             │
  (启动 REPL)────→│ 等待用户输入             │
                  └──┬─────────────┬─────────┘
                     │             │
         Ctrl+C      │             │ 用户输入非空行 → 斜杠 / sendTurn
                     ↓             │
         ┌──────────────────┐      │
         │  pending-exit    │      │
         │  1.5s 等再按一次 │      │
         └──┬────────┬──────┘      │
            │        │              │
   超时     │        │ Ctrl+C       │
      ↓    │        ↓              │
      │    │    process.exit(130)  │
      └─→ idle                     │
                                    ↓
                         ┌────────────────┐
                         │   streaming    │
                         │ agent loop 中  │
                         └─┬──────────────┘
                           │
                 Ctrl+C    │            正常完成
                           ↓                 ↓
                  abortController.abort()    │
                  → agent loop 抛 AbortError │
                  → catch 后 finally:         │
                            phase = idle     │
                           ←─────────────────┘
```

关键实现细节见 [repl-loop.md](./repl-loop.md)。

## 7. 关键类型索引（M2 新增签名）

```ts
// src/commands/ChatCommand/ChatSession.ts
interface SessionMeta {
  readonly sessionId: string;
  readonly model: string;
  readonly createdAt: string; // ISO 8601
}
interface ChatTurnContext {
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  readonly agentLoop?: typeof runAgentLoop;   // 测试注入
  readonly llmLogSink?: LlmLogSink;           // debug 时下传
}
class ChatSession {
  constructor(meta: SessionMeta, initialMessages?: readonly NovaMessage[]);
  readonly meta: SessionMeta;
  sendTurn(userInput: string, ctx: ChatTurnContext): AsyncGenerator<AgentEvent, void, void>;
  clear(): void;
  snapshot(): readonly NovaMessage[];
  restore(meta: SessionMeta, messages: readonly NovaMessage[]): void;
}

// src/commands/ChatCommand/sessionStore.ts
interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly messages: readonly NovaMessage[];
}
function saveSession(idOrAlias: string, snapshot: SessionSnapshot, source?: ConfigSource): Promise<string>;
function loadSession(idOrAlias: string, source?: ConfigSource): Promise<SessionSnapshot>;

// src/commands/ChatCommand/slash/types.ts
interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  run(ctx: SlashContext): Promise<SlashResult>;
}
type SlashResult =
  | { readonly action: "continue" }
  | { readonly action: "exit"; readonly exitCode?: number };

// src/commands/ChatCommand/slash/dispatcher.ts
type DispatchResult =
  | { readonly handled: false }
  | { readonly handled: true; readonly result: SlashResult };
function dispatchSlash(input: string, baseCtx: Omit<SlashContext, "args">): Promise<DispatchResult>;

// src/commands/ChatCommand/runChatRepl.ts
interface RunChatReplParams {
  readonly session: ChatSession;
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  readonly debugSink: DebugSink;
  readonly llmLogSink?: DebugSink;       // M2 新增
  readonly configSource?: ConfigSource;
  readonly io?: ReplIO;
}
function runChatRepl(params: RunChatReplParams): Promise<number>; // 0 / 130 / 2

// src/QueryEngine.ts（M2 扩展）
interface LlmLogSink {
  readonly write: (payload: unknown) => void;
}
interface AgentLoopParams {
  // 既有字段...
  readonly initialMessages?: readonly NovaMessage[];  // ← M2 新增
  readonly llmLogSink?: LlmLogSink;                   // ← M2 新增
}
```

## 8. 关键常量速查（M2 新增）

| 常量 | 位置 | 值 | 含义 |
|---|---|---|---|
| `PENDING_EXIT_WINDOW_MS` | `runChatRepl.ts` | `1500` | Ctrl+C 双按退出窗口（ms） |
| `generateSessionId` 随机后缀长度 | `sessionId.ts` | `4 bytes = 8 hex chars` | 同秒并发不撞，格式短 |
| `debugSink` 前缀 | `debugSink.ts` | `"ask" / "ask-llm" / "chat" / "chat-llm"` | 四种日志文件区分 |

## 9. 下一步读哪篇

- 想知道"消息如何原子追加、中途出错如何回滚" → [chat-session.md](./chat-session.md)
- 想知道"readline 怎么读 / SIGINT 怎么处理 / 输入怎么渲染" → [repl-loop.md](./repl-loop.md)
- 想知道"会话怎么落盘、sessionId 怎么生成、/save/load 怎么防穿越" → [session-store.md](./session-store.md)
- 想知道"斜杠命令怎么注册、怎么扩展" → [slash-commands.md](./slash-commands.md)
- 想知道"LLM 原始请求/响应日志怎么写、`initialMessages` 怎么让多轮跑起来" → [llm-debug-log.md](./llm-debug-log.md)
