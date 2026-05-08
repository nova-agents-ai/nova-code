# LLM 模块架构与调试指南

> 适用版本：nova-code v1.0.x  
> 范围：`src/config/`、`src/llm/`、`src/commands.ts` 中的 `ask` 命令
>
> **❗ M1.5 后目录结构已重组**：`src/llm/` 命名空间已完全删除。本文的模块全景与具体文件路径是 M0 时期的快照，仅供回溯阅读。最新的模块位置与移动说明请看 [`docs/design/M1.5-refactor.md`](../design/M1.5-refactor.md)；简单对应关系：
> - `src/llm/types.ts` → `src/types/message.ts`
> - `src/llm/errors.ts::LLMApiError` → `src/services/api/errors.ts`
> - `src/llm/errors.ts::{ConfigError,ToolExecutionError,AbortError,MaxTurnsExceededError}` → `src/errors/`
> - `src/llm/client.ts` → `src/services/api/client.ts`
> - `src/llm/query.ts` → `src/QueryEngine.ts`
> - `src/commands.ts` 拆 → `src/commands/{Hello,Echo,Ask}Command/`（`src/commands.ts` 瘦身为注册表）

---

## 1. 模块全景

```
src/
├── config/
│   └── config.ts          # 配置加载与持久化（API key / baseURL / model）
├── llm/
│   ├── types.ts           # 核心领域类型 + 枚举（NovaMessage / AgentEvent ...）
│   ├── errors.ts          # 错误层级（ConfigError / LLMApiError ...）
│   ├── client.ts          # @anthropic-ai/sdk 薄封装
│   ├── tools.ts           # Tool 抽象 + 内置工具（list_dir / read_file）
│   └── query.ts           # 🔥 Agent Loop 核心：流式 + 工具循环
├── commands.ts            # ask 命令：CLI ↔ runAgentLoop 适配层
└── index.ts               # 公共 API 桶式导出
```

**职责分层（自顶向下，单向依赖）**：

```
┌─────────────────────────────────────────────────────┐
│  commands.ts (CLI 适配)                              │
│    ↓ 消费 AgentEvent 流，写 stdout/stderr           │
├─────────────────────────────────────────────────────┤
│  llm/query.ts (Agent Loop 编排)                     │
│    ↓ 协调 client + tools + config                   │
├─────────────────────────────────────────────────────┤
│  llm/client.ts │ llm/tools.ts │ config/config.ts   │
│    ↓ 各自单一职责                                    │
├─────────────────────────────────────────────────────┤
│  llm/types.ts │ llm/errors.ts (无依赖叶子)          │
└─────────────────────────────────────────────────────┘
```

---

## 2. 核心链路：Agent Loop

`runAgentLoop(options) → AsyncGenerator<AgentEvent, void>`

```
用户 prompt
  │
  ▼
┌──────────────────────────────────────────────────┐
│ 1. 构造初始 messages: [{role: USER, content}]    │
└──────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────┐
│ 2. for turn in 1..maxTurns: ◄────────────────┐   │
│                                              │   │
│   yield { type: 'turn_start', turn }         │   │
│             │                                │   │
│             ▼                                │   │
│   ┌─────────────────────────────────────┐    │   │
│   │ client.messages.stream(...)         │    │   │
│   │   for await event of stream:        │    │   │
│   │     yield { type: 'text_delta' } ←UI│    │   │
│   │   final = await stream.finalMessage │    │   │
│   └─────────────────────────────────────┘    │   │
│             │                                │   │
│             ▼                                │   │
│   messages.push(assistantMessage)            │   │
│   yield { type: 'turn_end', message, ... }   │   │
│             │                                │   │
│             ▼                                │   │
│   stop_reason 判断:                          │   │
│     END_TURN/STOP_SEQUENCE/MAX_TOKENS/...    │   │
│       → yield { type:'done' } 然后 return    │   │
│     TOOL_USE → 继续                          │   │
│             │                                │   │
│             ▼                                │   │
│   提取所有 tool_use blocks                   │   │
│   for each toolUse:                          │   │
│     yield { type: 'tool_call', ... }         │   │
│     try: result = tool.execute(input, ctx)   │   │
│     catch: result = error.message; isError=true
│     yield { type: 'tool_result', ... }       │   │
│                                              │   │
│   构造 user message {                        │   │
│     role: USER,                              │   │
│     content: [tool_result blocks...]         │   │
│   }                                          │   │
│   messages.push(toolResultMessage)           │   │
│             │                                │   │
│             └───── 进入下一轮 ────────────────┘   │
│                                                  │
│ 3. 超过 maxTurns → throw MaxTurnsExceededError   │
└──────────────────────────────────────────────────┘
```

**关键不变量**：

- 每轮结束后 `messages` 都是合法的 Anthropic 对话历史：`assistant` 含 `tool_use` 后必接 `user` 含 `tool_result`
- `AgentEvent` 是**纯可视化事件流**，调用方可全部丢弃也不影响 loop 正确性
- 终止只有三种途径：模型自然结束（`done`）/ 超过 `maxTurns`（抛错）/ `AbortSignal` 中断（抛 `AbortError`）

---

## 3. 类型与数据流

### 3.1 核心类型（`src/llm/types.ts`）

```typescript
// 域消息（与 SDK MessageParam 形状对齐，但收窄字段）
interface NovaMessage {
  readonly role: MessageRoleEnum;          // USER | ASSISTANT
  readonly content: string | readonly NovaContentBlock[];
}

// 内容块（Discriminated Union，type 字段做判别）
type NovaContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// Agent 事件流（驱动 UI / 日志 / debug）
type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }              // 流式 token
  | { type: 'turn_end'; turn: number; message: NovaMessage; stopReason: AgentStopReasonEnum }
  | { type: 'tool_call'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError: boolean }
  | { type: 'done'; turns: number; finalMessage: NovaMessage };
```

**设计要点**：

- `NovaContentBlock` 用 `type` 字段做 discriminated union → 调用方 `switch (block.type)` 自动收窄
- `MessageRoleEnum` / `AgentStopReasonEnum` 替代 magic string
- `readonly` 全程贯穿，强制不可变

### 3.2 错误层级（`src/llm/errors.ts`）

```
NovaError (abstract base)
  ├── ConfigError              // 配置缺失/损坏（如无 API key）
  ├── LLMApiError              // SDK 返回的 API 错误（含 statusCode）
  ├── ToolExecutionError       // 工具执行抛错（含 toolName）
  ├── AbortError               // 用户主动中断（AbortSignal）
  └── MaxTurnsExceededError    // 工具循环超限
```

每种错误都是**领域语义**。CLI 层 `commands.ts` 用 `instanceof` 分类映射成退出码：

| 错误 | 退出码 | 触发场景 |
|---|---|---|
| `ConfigError` | 1 | 缺 `NOVA_API_KEY`、配置文件 JSON 损坏 |
| `AbortError` | 130 | 用户按 Ctrl+C |
| `MaxTurnsExceededError` | 2 | 工具调用超过 `maxTurns`（默认 25） |
| `LLMApiError` | 2 | 4xx/5xx、网络错误、SSE 中断 |
| 其他 `Error` | 2 | 兜底 |

### 3.3 数据流：messages 演化

以"列出当前目录的 ts 文件"为例：

```
turn 1 输入 messages:
  [{ role: USER, content: 'list ts files' }]

turn 1 输出 assistantMessage（stop_reason=tool_use）:
  { role: ASSISTANT, content: [
      { type:'text', text:'I will list...' },
      { type:'tool_use', id:'tu_01', name:'list_dir', input:{path:'.'} }
  ]}

turn 1 末尾构造 toolResultMessage:
  { role: USER, content: [
      { type:'tool_result', tool_use_id:'tu_01', content:'a.ts\nb.ts...', is_error:false }
  ]}

turn 2 输入 messages（已累积 3 条）:
  [user_prompt, assistant_with_tool_use, user_with_tool_result]

turn 2 输出 assistantMessage（stop_reason=end_turn）:
  { role: ASSISTANT, content: [{type:'text', text:'Found: a.ts, b.ts'}]}
  → 退出循环，emit done event
```

---

## 4. 模块关系（依赖与调用）

```
                 ┌──────────────┐
                 │   bin/cli    │
                 └──────┬───────┘
                        │ runCli() → 解析 argv → findCommand
                        ▼
                 ┌──────────────┐
                 │ src/cli.ts   │
                 └──────┬───────┘
                        │ command.run(rest)
                        ▼
        ┌────────────────────────────────────┐
        │     src/commands.ts (askCommand)   │
        │  ┌──────────────────────────────┐  │
        │  │ parseAskFlags(args)          │  │
        │  │ for await ev of runAgentLoop:│  │
        │  │   if debug: writeDebug(ev)   │  │
        │  │   switch ev.type:            │  │
        │  │     text_delta → stdout      │  │
        │  │     tool_call → stderr       │  │
        │  └──────────────────────────────┘  │
        └──────┬─────────────────────────────┘
               │ runAgentLoop({config, prompt, tools, signal})
               ▼
   ┌──────────────────────────────────────────┐
   │       src/llm/query.ts (Agent Loop)      │
   │                                          │
   │   loadConfig() ──► config.ts             │
   │       │                                  │
   │       ▼                                  │
   │   createAnthropicClient(cfg) ──► client.ts ──► @anthropic-ai/sdk
   │       │                                  │
   │       ▼                                  │
   │   for turn in 1..maxTurns:               │
   │     client.messages.stream(...)          │
   │     findTool(name) ──► tools.ts          │
   │     tool.execute(input, {signal}) ──► fs/promises etc.
   └──────────────────────────────────────────┘
                  │ 全程 yield AgentEvent
                  ▼
            AsyncGenerator<AgentEvent>
```

**单向依赖原则**：`query.ts` 是唯一的"编排者"，组合 `client` + `tools` + `config`。`client.ts` / `tools.ts` / `config.ts` 互不感知（横向解耦）。`types.ts` / `errors.ts` 是无依赖叶子。

---

## 5. 关键设计取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 流式 vs 批量 | `messages.stream()` | 用户感知延迟低；SDK 已封装事件解析 |
| AsyncGenerator vs EventEmitter | AsyncGenerator | 类型安全（`yield` 受 `AgentEvent` 联合约束）；调用方用 `for await` 自然处理背压 |
| Tool 抽象粒度 | `name + description + input_schema + execute` 四元组 | 与 Anthropic SDK 的 `Tool` 形状对齐；`execute` 返回 `string` 简化序列化 |
| 工具同步/异步 | `execute(input, ctx): string \| Promise<string>` | 留出 IO 空间；纯计算工具可同步 |
| 工具错误传递 | 包成 `tool_result {is_error:true}` 回喂 LLM | 让模型自己看到错误并决定重试/绕过；避免一个工具失败就中断整个 loop |
| 配置优先级 | env > 文件 > 默认 | 12-factor 标准；CI/容器友好 |
| `maxTurns` 默认值 | 25（`DEFAULT_MAX_TURNS`） | 防止工具循环爆炸；可通过配置文件 `{ "maxTurns": N }` 覆盖 |
| 不引入 React/Ink | 纯流式 stdout | 当前 CLI 仅需文本输出；保持轻量 |
| 不暴露 SDK 类型 | 仅 `query.ts/client.ts` 内部使用 | SDK 的 `ContentBlockParam` 是 25+ 项巨型联合，暴露给上层会让消费方处理大量永远收不到的分支 |

---

## 6. 调试指南 🔧

### 6.1 用 `--debug` 看完整事件流（首选）

```bash
nova-code ask --debug "list ts files in src/"
```

`--debug` 的输出去向：

- **stderr**：实时打印 `[debug] {json}`，便于交互观察；首行还会提示日志文件路径
- **`~/.nova-code/logs/ask-<YYYY-MM-DDTHH-mm-ss>-<pid>.log`**：同一份内容追加到磁盘，单次会话一个文件，按时间排序

文件名形如 `ask-2026-05-01T15-11-23-42649.log`，**字典序 = 时序**，`ls -lt ~/.nova-code/logs` 直接看到最近的会话。重定向 stderr 是可选的（仅当你想完全隐藏调试输出）：

```bash
nova-code ask --debug "..." 2>/dev/null
# stdout 仍是答案；完整事件流仍写入 ~/.nova-code/logs/
```

无论哪种用法，`stdout` 始终是干净的答案文本，可安全 pipe 给后续命令。结合 `jq` 离线分析：

```bash
# 找到最近一次会话的日志
LOG=$(ls -t ~/.nova-code/logs/ask-*.log | head -1)

# 只看 turn 边界
sed 's/^\[debug\] //' "$LOG" | jq 'select(.type=="turn_start" or .type=="turn_end")'

# 只看工具调用与结果
sed 's/^\[debug\] //' "$LOG" | jq 'select(.type=="tool_call" or .type=="tool_result")'

# 看每轮 stop_reason，判断是否陷入工具循环
sed 's/^\[debug\] //' "$LOG" | jq 'select(.type=="turn_end") | {turn, stopReason}'
```

debug 模式还会在最前打一条 `config_loaded`：

```json
[debug] {"type":"config_loaded","model":"claude-sonnet-4-5","baseURL":null,"apiKeyTail":"abcd"}
```

用来确认**实际生效的配置**——排查"为什么连到了错误的 endpoint / 用错了 model / API key 没读到"等问题。`apiKeyTail` 只露最后 4 位，安全。

> 注意：§6.5 的 jq 表达式只对 `turn_end` 事件有效（其 `message.content` 一定是 block 数组）。其它事件如初始 `user_prompt` 的 `content` 是字符串，不要直接对它用 `map(.type)`。

### 6.2 把请求转发到本地 mock（隔离 LLM 端）

仓库内置了一个最小 SSE mock：[`scripts/mock-anthropic.ts`](../scripts/mock-anthropic.ts)。它实现了 Anthropic Messages API 的 stream 协议（`message_start` / `content_block_start|delta|stop` / `message_delta` / `message_stop`），无需鉴权，**完全离线**就能跑通整条 agent loop。

**启动 mock**：

```bash
# 终端 A：默认监听 8787
bun run mock

# 或自定义端口
PORT=9000 bun run mock
```

**调用 ask 走 mock**：

```bash
# 终端 B：simple 剧本（默认）—— 单轮 end_turn，验证流式文本路径
NOVA_API_KEY=anything NOVA_BASE_URL=http://localhost:8787 \
  bun run start -- ask --debug "hi"

# 终端 B：tool 剧本 —— 第一轮返回 tool_use(list_dir)，
#                    收到 tool_result 后第二轮 end_turn。
#                    验证完整工具循环路径（含 messages 累积）
NOVA_API_KEY=anything NOVA_BASE_URL='http://localhost:8787/?scenario=tool' \
  bun run start -- ask --debug "list ts files"
```

> `NOVA_API_KEY=anything`：mock 不验证 key，但 nova-code 的 `loadConfig` 要求 key 必须存在，给个占位即可。

**剧本判定逻辑**（见 mock 源文件 `buildScenarioEvents`）：`tool` 剧本通过检查请求 body 里 `messages[]` 是否已包含 `tool_result` 块来自动决定返回第一轮还是第二轮——调用方无需切换 query 参数。

**适用场景**：
- 排查 SDK 事件解析差异（升级 `@anthropic-ai/sdk` 时跑一遍 mock 就能确认事件契约没破）
- 在 CI / 容器 / 离线环境验证 nova-code 端到端可用
- 复现 messages 累积 / stop_reason 映射 / 工具循环相关的 bug，零成本零延迟

### 6.3 单测隔离（不发真实请求）

`src/llm/query.test.ts` 已经示范了如何用 mock client 跑 agent loop。新增工具或新增循环逻辑时，**先加单测再改实现**：

```bash
bun test src/llm/query.test.ts --watch
```

`bun test` 默认 50ms 内全套跑完，反馈极快。

### 6.4 用 `AbortSignal` 排查"卡住"

如果 ask 看起来卡住没输出，但 debug 流仍在跳：网络慢或模型慢，正常；
如果 debug 流完全静默 > 30s：很可能是 SSE 解析器卡在等不到的事件。Ctrl+C 触发 `AbortError`，看 stack trace 定位卡点。

如需"硬超时"，可在 `runAgentLoop` 调用处包一层：

```typescript
const ac = new AbortController();
setTimeout(() => ac.abort(), 60_000);
runAgentLoop({ ..., signal: ac.signal });
```

### 6.5 看 `messages` 累积形态

最容易出 bug 的地方是**消息历史构造错误**（assistant tool_use 没接 user tool_result，模型直接 400）。  
用 `--debug` 抓 `turn_end` 事件，每条都包含完整 `message`。把若干 `turn_end.message` 拼起来就是 `messages` 的演化：

```bash
nova-code ask --debug "..." 2>&1 1>/dev/null \
  | grep '^\[debug\]' | sed 's/^\[debug\] //' \
  | jq -s 'map(select(.type=="turn_end") | {turn, role: .message.role, blocks: .message.content | map(.type)})'
```

输出形如：

```json
[
  {"turn":1,"role":"assistant","blocks":["text","tool_use"]},
  {"turn":2,"role":"assistant","blocks":["text"]}
]
```

如果某轮 `assistant` 含 `tool_use`，但下一轮 `messages` 里没出现对应的 `user/tool_result`，就是 loop bug。

### 6.6 常用排查清单

用户看到的所有 `ask: ...` 错误都源自 `src/commands.ts handleAskError` 的分类映射。下表的 "stderr 文案" 为实际打印格式（不是错误类名）：

| stderr 文案（节选） | 大概率原因 | 排查动作 |
|---|---|---|
| `ask: LLM API key not configured. Set the NOVA_API_KEY ...` | 没设 `NOVA_API_KEY` 也没写配置文件 | `cat ~/.nova-code/config.json` 或 `env \| grep NOVA_` |
| `ask: LLM 请求失败 (HTTP 401)：...` | API key 错了 | `--debug` 看 `config_loaded.apiKeyTail` 是否正确 |
| `ask: LLM 请求失败 (HTTP 400)：messages: ... unexpected role` | tool_use ↔ tool_result 配对错了 | 用 §6.5 的 `messages` 形态检查 |
| `ask: Agent loop exceeded maxTurns=25. The model kept calling tools ...` | 模型陷入工具循环 | `--debug` 看每轮 `tool_call.input` 是否在重复同样调用 |
| `ask: Tool 'read_file' threw: ENOENT ...` | 工具被喂了不存在的路径 | `--debug` 看 `tool_call.input.path`，并检查工具的 `input_schema.description` 是否够清晰 |
| `ask: 已中断。`（退出码 130） | 用户按 Ctrl+C，转成 `AbortError` | 正常行为，无需处理 |
| stdout 里突然多了 `[tool] ...` 之类的字符串 | 误把 stderr 内容重定向到 stdout | 检查 shell 重定向：`2>&1` 顺序；保持 stdout 干净 |

---

## 7. 与 claude-code 原版的对照

| 维度 | claude-code 原版 | nova-code 移植版 |
|---|---|---|
| 总代码量 | ~3000+ 行（含 React UI、VCR、cost-tracker、retry、provider 切换） | ~700 行（5 个文件） |
| Provider | Anthropic / Bedrock / Vertex | 仅 Anthropic |
| 流式 UI | Ink + React 组件树 | 纯 stdout 文本 |
| 工具系统 | 12+ 内置工具（含 Bash/Edit/Write） | 2 个只读工具（`list_dir` / `read_file`）— **安全优先** |
| 重试 / cost / VCR | 全有 | 全省略 — 后续按需加 |
| 核心循环 | `query()` + `queryLoop()` 递归 | `runAgentLoop()` 单层 for + 显式 `maxTurns` — 更易测 |

**保留的本质**：流式 token + 工具调用循环 + messages 累积 + stop_reason 终止判定。这是 agent loop 的最小完整骨架。

---

## 8. 扩展指引

| 想做 | 怎么改 |
|---|---|
| 加新工具 | 在 `src/llm/tools.ts` 实现 `Tool` 接口，加入 `builtinTools` 数组 |
| 加新 provider | 抽 `client.ts` 为 `LLMClient` 接口（同形于 SDK 的 `messages.stream`），让 `query.ts` 依赖接口而非具体实现 |
| 持久化对话 | 把 `runAgentLoop` 的 `messages` 累积逻辑提到外层 `Conversation` 类，loop 改为 `runOneTurn` |
| 接入 UI | 直接消费 `AgentEvent` 流即可，无需改 loop 本身 |
| 接 cost tracker | 监听 `turn_end` 事件，从 `message` 上读 `usage`（需要先在 `NovaMessage` 上补 `usage` 字段） |
