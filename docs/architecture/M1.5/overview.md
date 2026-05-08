# 01 · Overview —— 全局鸟瞰

> 先读本篇获得全局观，再按需跳读其他文档。

## 1. 一张图读懂 nova-code

```
┌─────────────────────────────────────────────────────────────────┐
│                      bin/nova-code.ts                           │
│   读 package.json 元信息 → runCli({name,version,description}) │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                        src/cli.ts                               │
│   - 解析 argv[0] 作为子命令                                     │
│   - 顶层 flag: -h/--help / -v/--version                         │
│   - findCommand → command.run(rest)                             │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                   src/commands.ts (聚合)                        │
│   builtinCommands = [helloCommand, echoCommand, askCommand]     │
└──────┬──────────────┬───────────────────────┬───────────────────┘
       ↓              ↓                       ↓
  HelloCommand/   EchoCommand/           AskCommand/
  （纯打印）       （纯打印）            AskCommand.ts
                                        ├─ parseAskFlags.ts
                                        ├─ debugSink.ts
                                        └─ runAskWithLLM.ts
                                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  src/QueryEngine.ts (agent loop)                │
│   runAgentLoop(): AsyncGenerator<AgentEvent, NovaMessage>       │
│   - 调 LLM → 转发 text_delta                                    │
│   - 拿到完整 assistant message → 检查 stop_reason               │
│   - tool_use? 并行执行工具 → tool_result 回发模型               │
│   - end_turn? 结束循环                                          │
│   - 超过 maxTurns? 抛 MaxTurnsExceededError                     │
└─────┬────────────────────┬──────────────────────┬───────────────┘
      ↓                    ↓                      ↓
┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐
│ services/api │   │   src/tools.ts  │   │   src/config/        │
│ - client.ts  │   │  (注册表)       │   │   config.ts          │
│ - withRetry  │   │  → tools/<X>/   │   │  (env > 文件 > 默认) │
│ - errors.ts  │   │  7 个内置工具   │   └──────────────────────┘
│ - errorUtils │   └─────────────────┘
└──────┬───────┘
       ↓
 Anthropic SDK
```

## 2. src/ 目录全景

```
src/
├── Tool.ts             61 行   工具接口（零依赖）
├── cli.ts              116 行  runCli 主流程
├── commands.ts         43 行   命令聚合（re-export + findCommand）
├── index.ts            52 行   库入口（对外导出）
├── tools.ts            50 行   工具注册表（re-export + findTool）
├── QueryEngine.ts      464 行  agent loop 核心
│
├── commands/
│   ├── types.ts              CommandDefinition / CommandHandler
│   ├── HelloCommand/         无 LLM 调用，演示命令骨架
│   ├── EchoCommand/          无 LLM 调用，演示命令骨架
│   └── AskCommand/
│       ├── AskCommand.ts       命令定义 + 退出码映射
│       ├── parseAskFlags.ts    解析 --debug / --model / --max-turns
│       ├── debugSink.ts        可选 debug 日志文件写入
│       └── runAskWithLLM.ts    消费 AgentEvent → stdout / stderr
│
├── config/
│   └── config.ts             ResolvedConfig / loadConfig / save…
│
├── errors/
│   ├── AbortError.ts           退出码 130
│   ├── ConfigError.ts          退出码 1
│   ├── MaxTurnsExceededError   退出码 2
│   ├── ToolExecutionError      退出码 2（走 is_error 反馈模型，agent 层不退出）
│   └── index.ts                聚合 re-export
│
├── services/api/
│   ├── client.ts               createAnthropicClient（SDK 薄包装）
│   ├── errors.ts               LLMApiError
│   ├── errorUtils.ts           isRetryableError / httpStatusFromError
│   └── withRetry.ts            指数退避重试
│
├── tools/
│   ├── utils.ts                工具共用 helper（路径校验、安全拼接等）
│   ├── LSTool/
│   ├── FileReadTool/
│   ├── FileWriteTool/
│   ├── FileEditTool/
│   ├── BashTool/
│   ├── GrepTool/
│   └── GlobTool/
│       每个子目录 = <ToolName>.ts + <ToolName>.test.ts
│
└── types/
    └── message.ts              NovaMessage / NovaContentBlock / AgentEvent
                                MessageRoleEnum / AgentStopReasonEnum
```

三条不写进代码但读者必须掌握的关系：

1. **顶层 `src/Tool.ts` / `src/tools.ts` / `src/commands.ts` 是聚合层**，对齐 claude-code 同名文件；具体实现下沉到子目录。阅读时先看聚合再看子目录。
2. **`src/errors/` 与 `src/services/api/errors.ts` 是两组错误**：前者是 nova-code 领域错误（Abort/Config/MaxTurns/ToolExec），后者是 LLM 网络错误（LLMApiError）。上层捕获时都得认。
3. **`src/types/` 是跨模块领域类型**，不是"随便塞接口"的垃圾堆。当前只有 `message.ts`（消息 + 事件）。

## 3. 分层依赖（单向，允许跳层）

```
                    cli.ts
                      │
           ┌──────────┼──────────┐
           ↓          ↓          ↓
     commands/*   commands.ts   (top-level)
           │          │
           └─────┬────┘
                 ↓
           QueryEngine.ts
                 │
     ┌───────┬───┴────┬──────────┬──────────┐
     ↓       ↓        ↓          ↓          ↓
 tools.ts  config/  errors/  services/api/ types/
     │
     ↓
 tools/<X>/ ─┐
             └→ tools/utils.ts
```

**强制规则**：

- `types/` 与 `errors/` 是叶子层，零业务依赖。可以被任何层 import。
- `config/` 只依赖 `errors/`。
- `services/api/` 只依赖 `errors/` + SDK。
- `tools/<X>/` 只依赖 `Tool.ts` + `tools/utils.ts` + `errors/` + Node 标准库。**工具之间互不 import**。
- `QueryEngine.ts` 可以依赖上述全部，不依赖 `commands/`。
- `commands/` 可以依赖上述全部。
- `cli.ts` 只依赖 `commands.ts`。

破坏这些方向即意味着"这个改动要重新审视"。

## 4. 一次 `nova-code ask "..."` 的端到端时序

```
用户 shell
  └─ bin/nova-code.ts
       ├─ import packageJson
       └─ runCli({name,version,description})
           └─ src/cli.ts :: runCli
               ├─ argv = process.argv.slice(2)          // ["ask","你好"]
               ├─ findCommand("ask")                    // → askCommand
               └─ askCommand.run(["你好"])
                   └─ src/commands/AskCommand/AskCommand.ts
                       ├─ parseAskFlags(rest)           // {prompt,model?,maxTurns?,debug?}
                       ├─ resolveConfig(flags)          // 合并 env / 文件 / 默认
                       │   └─ loadPersistedConfig()     // ~/.nova-code/config.json
                       ├─ (可选) openDebugSink(...)      // 打开 jsonl 日志文件
                       ├─ runAskWithLLM(...)            // 消费事件流 → stdout
                       │   └─ runAgentLoop({config,userPrompt,tools,signal})
                       │       ├─ client = createAnthropicClient(config)
                       │       ├─ for turn in 1..maxTurns:
                       │       │   ├─ yield turn_start
                       │       │   ├─ stream = client.messages.stream(...)
                       │       │   ├─ for event of stream: yield text_delta
                       │       │   ├─ final = await stream.finalMessage()
                       │       │   ├─ yield turn_end
                       │       │   ├─ 无 tool_use → yield done → return
                       │       │   ├─ yield tool_call × N
                       │       │   ├─ Promise.allSettled(tools.map(execute))
                       │       │   ├─ yield tool_result × N
                       │       │   └─ 把 tool_result 打包为 user message → continue
                       │       └─ 超过 maxTurns → throw MaxTurnsExceededError
                       └─ 返回退出码（0 / 1 / 2 / 130）
           └─ process.exit(exitCode)
```

阅读建议：把本图打印在旁边，其它文档都是对图中某一段的放大。

## 5. 关键类型索引（先记住签名，再读实现）

```ts
// src/Tool.ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ToolInputSchema;
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ) => string | Promise<string>;
  readonly requiresApproval?: boolean;
}

// src/QueryEngine.ts
function runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentEvent, NovaMessage, void>;

// src/types/message.ts
type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "turn_end"; turn: number; message: NovaMessage; stopReason: AgentStopReasonEnum }
  | { type: "tool_call"; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; toolName: string; content: string; isError: boolean }
  | { type: "done"; turns: number; finalMessage: NovaMessage };

// src/services/api/withRetry.ts
function withRetry<T>(fn: () => Promise<T>, options?: WithRetryOptions): Promise<T>;

// src/cli.ts
interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly commands?: readonly CommandDefinition[];
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
}
function runCli(options?: RunCliOptions): Promise<number>;
```

## 6. 关键常量速查

| 常量 | 位置 | 值 | 含义 |
|---|---|---|---|
| `DEFAULT_MAX_ATTEMPTS` | `services/api/withRetry.ts` | `3` | 重试总次数上限（含首次） |
| `DEFAULT_INITIAL_DELAY_MS` | 同上 | `500` | 首次退避起始延迟 |
| `DEFAULT_MAX_DELAY_MS` | 同上 | `16_000` | 单次退避延迟上限（含抖动） |
| `MAX_FILE_BYTES` | `tools/FileReadTool` | `1 MB` | 单次读文件上限 |
| `WRITE_MAX_FILE_BYTES` | `tools/FileWriteTool` | `5 MB` | 单次写文件上限 |
| `BASH_MAX_OUTPUT_BYTES` | `tools/BashTool` | `1 MB` | stdout+stderr 合并上限 |
| `BASH_SIGTERM_GRACE_MS` | 同上 | `500` | 超时后先发 SIGTERM 的宽限期 |
| `BASH_SIGKILL_GRACE_MS` | 同上 | `1000` | 再发 SIGKILL 前的宽限期 |
| `GREP_MAX_MATCHES` | `tools/GrepTool` | `200` | 单次搜索最多返回匹配数 |
| `GLOB_MAX_RESULTS` | `tools/GlobTool` | `500` | 单次 glob 最多返回路径数 |

## 7. 下一步读哪篇

- 想知道"`ask` 是怎么把 flag 变成一次 LLM 调用" → [commands-and-cli.md](./commands-and-cli.md)
- 想知道"多轮对话是怎么运转的" → [agent-loop.md](./agent-loop.md)
- 想知道"SDK 怎么被封装、重试怎么做的" → [services-api.md](./services-api.md)
- 想知道"工具怎么写、怎么注册、怎么安全" → [tools.md](./tools.md)
- 想知道"配置从哪来、错误怎么分类" → [config-and-errors.md](./config-and-errors.md)
- 想知道"测试怎么跑、LLM 怎么 mock" → [testing.md](./testing.md)
