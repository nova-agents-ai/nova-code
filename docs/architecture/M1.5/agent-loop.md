# 03 · Agent Loop —— `src/QueryEngine.ts` 详解

> 对应文件：[src/QueryEngine.ts](../../src/QueryEngine.ts)（464 行）
> 测试：[src/QueryEngine.test.ts](../../src/QueryEngine.test.ts)

Agent loop 是整个工程的"发动机"。只有一个公开入口 `runAgentLoop`，所有多轮对话逻辑都在这里。

---

## 1. 入口签名

```ts
export async function* runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentEvent, NovaMessage, void>;

export interface AgentLoopParams {
  readonly config: ResolvedConfig;            // apiKey/model/maxTokens/maxTurns
  readonly userPrompt: string;                // 会包成第一条 user message
  readonly systemPrompt?: string;             // 缺省使用内置简短提示
  readonly tools: readonly Tool[];            // 空数组即关闭工具调用
  readonly signal?: AbortSignal;              // Ctrl+C 中断
  readonly client?: Anthropic;                // DI：测试时注入 mock
}
```

设计取舍：

- **AsyncGenerator 而非 callback**：`yield` 事件给调用方做 UI 渲染，`return` 值是最终 assistant message，`throw` 代表不可挽救失败。三通道语义清晰。
- **config 必传**：loop 不读环境变量、不读配置文件，全靠 caller 预先解析好的 `ResolvedConfig`。方便测试与多实例复用。
- **client 可注入**：默认通过 `createAnthropicClient(config)` 构造；测试时可传入 `FakeClient`（见 [testing.md](./testing.md)）。

---

## 2. 主循环伪代码

```
messages = [{role: user, content: userPrompt}]

for turn in 1..maxTurns:
    if signal.aborted: throw AbortError
    yield turn_start(turn)

    (assistantMessage, stopReason) = yield* streamOneTurn(...)
    messages.push(assistantMessage)
    yield turn_end(turn, assistantMessage, stopReason)

    if stopReason != TOOL_USE:
        yield done(turn, assistantMessage)
        return assistantMessage                   // ← generator return

    toolUses = extractToolUses(assistantMessage)
    if toolUses.empty:
        yield done; return                        // 防御：SDK 报 tool_use 但无 block

    toolResults = yield* executeToolsAndYieldEvents(toolUses, tools, signal)
    messages.push({role: user, content: toolResults})

throw MaxTurnsExceededError(maxTurns)
```

关键设计点：

1. **信号检查插在 turn 入口与流消费过程中**——不把 AbortSignal 只丢给 SDK，避免 SDK 层抽象不透明时信号被吞。
2. **assistantMessage 是最后一轮的完整内容**——return 值不是拼接历史。调用方想要历史需要自己监听 `turn_end` 事件累积。
3. **`maxTurns` 的含义是"LLM 被调用的最多次数"**。第 N 轮执行完工具后如果还是 TOOL_USE 且 N == maxTurns，下一轮会因超限抛错——模型不会收到最后那批 tool_result 的回复。

---

## 3. 事件流（AgentEvent）

事件是 agent loop 对外的唯一语义接口，共 6 种（定义见 [src/types/message.ts](../../src/types/message.ts)）：

| type | 发射时机 | 载荷 | 典型消费 |
|---|---|---|---|
| `turn_start` | 每轮 LLM 调用前 | `{turn}` | 进度条 +1 |
| `text_delta` | SDK stream 产生 `content_block_delta.text_delta` | `{delta}` | `process.stdout.write(delta)` |
| `turn_end` | 本轮 stream 完成 | `{turn, message, stopReason}` | 更新上下文 token 计数 |
| `tool_call` | 并行执行前，按声明顺序逐个 yield | `{toolUseId, toolName, input}` | 显示 "⚡ 执行 Bash(...)" |
| `tool_result` | 每个工具 `executeOneTool` settle 后 | `{toolUseId, toolName, content, isError}` | 显示结果或错误 |
| `done` | 循环正常结束 | `{turns, finalMessage}` | 打印总结 |

**事件顺序保证**：

```
turn_start(1)
  text_delta × N
turn_end(1, message, TOOL_USE)
  tool_call × K          ← 按 toolUses 声明顺序
  tool_result × K        ← 按工具完成顺序（Promise.allSettled）
turn_start(2)
  ...
turn_end(K, message, END_TURN)
done
```

注意 `tool_call` 全部 yield 完才开始 `Promise.allSettled`，所以 UI 可以先一次性展示"即将并发执行 3 个工具"。但 `tool_result` 的顺序取决于哪个工具先完成。

---

## 4. `streamOneTurn` 的细节

```ts
async function* streamOneTurn(params): AsyncGenerator<AgentEvent, {assistantMessage, stopReason}>
```

1. 把 `messages: NovaMessage[]` 转换为 SDK 的 `MessageParam[]`（`toSdkMessageParam`）
2. 调 `client.messages.stream({model, max_tokens, system, messages, tools?}, {signal})`
3. `for await` 消费 `RawMessageStreamEvent`：
   - 只挑出 `content_block_delta.text_delta`，`yield { type: "text_delta", delta }`
   - 其它事件（`content_block_start`、`message_delta`、`ping`...）被 SDK 内部累积，上层不暴露
4. `await stream.finalMessage()` 拿到完整 `SdkMessage`
5. `fromSdkMessage` 转换：只保留 `text` 和 `tool_use` 两类块；`thinking` / `server_tool_use` 等一律丢弃
6. `mapStopReason` 把 SDK 的 `stop_reason` 映射到 `AgentStopReasonEnum`（含 `end_turn` / `tool_use` / `max_tokens` / `stop_sequence` / `refusal` / `pause_turn`）

**错误归一化**——两处捕获，统一走 `normalizeSdkError`：

```ts
function normalizeSdkError(error: unknown): Error {
  if (error instanceof AbortError)         return error;
  if (error instanceof APIUserAbortError)  return new AbortError();
  if (error instanceof APIError)           return new LLMApiError(msg, {status, cause});
  if (error instanceof Error)              return new LLMApiError(`LLM request failed: ${msg}`, {cause});
  return new LLMApiError(`LLM request failed: ${String(error)}`);
}
```

`cause` 一直保留，上层 debug sink 可以拿到原始 SDK 错误的堆栈。

---

## 5. 工具执行：`executeToolsAndYieldEvents`

```
for use of toolUses:
    yield tool_call(use)                         // 先一口气全 yield
settled = await Promise.allSettled(
    toolUses.map(use => executeOneTool(use, tools, signal))
)
for [idx, outcome] of settled.entries():
    use = toolUses[idx]
    if fulfilled:
        push tool_result block {content: outcome.value}
        yield tool_result(...)                   // isError: false
    else:
        msg = describeToolError(outcome.reason, use.name)
        push tool_result block {content: msg, is_error: true}
        yield tool_result(...)                   // isError: true
return results                                   // 交回主 loop 附加到 messages
```

### 5.1 工具查找

```ts
function executeOneTool(use, tools, signal): Promise<string> {
  const tool = findTool(use.name, tools);
  if (tool === undefined) {
    throw new ToolExecutionError(use.name,
      `Unknown tool '${use.name}'. Available tools: ${...}.`);
  }
  return await tool.execute(use.input, { signal });
}
```

模型瞎编工具名时的行为是**正反馈**：抛 `ToolExecutionError` → 被 `describeToolError` 包成字符串 → 作为 `is_error=true` 的 tool_result 送回模型 → 模型下一轮能看到"Unknown tool 'BogusName'. Available tools: LS, FileRead, ..."自己纠正。不退出 loop。

### 5.2 错误描述

```ts
function describeToolError(reason, fallbackToolName): string {
  if (reason instanceof ToolExecutionError) return reason.message;   // 带上下文
  if (reason instanceof Error) return `Tool '${fallbackToolName}' threw: ${reason.message}`;
  return `Tool '${fallbackToolName}' threw: ${String(reason)}`;
}
```

工具内部应该抛 `ToolExecutionError`（能携带 `toolName`）；但任何 `throw "string"` 也能兜住，不会炸到上层。

### 5.3 并行而非串行

`Promise.allSettled` 一次提交所有工具。单个工具抛错**不影响**其它工具继续执行——这和 shell 的 `&` 并发语义一致。claude-code 的对应实现也是并行。

**副作用风险**：如果模型一轮里同时发出 `FileWrite(a.txt)` 和 `FileEdit(a.txt)`，两者会并发跑，结果依赖调度顺序。M1 的态度是"模型应当在 prompt 里被教育不要这样做"；M3 引入权限审批后会在 agent loop 之外做冲突检测。

---

## 6. 类型转换层（nova ↔ SDK）

SDK 的 `ContentBlockParam` 是 25+ 项的巨型联合类型（text / image / document / tool_use / tool_result / thinking / server_tool_use / web_search_tool_result / code_execution_tool_result / ...）。nova-code 只关心 `text` / `tool_use` / `tool_result` 三种，所以在 `QueryEngine.ts` 末尾做了严格边界：

| 函数 | 方向 | 职责 |
|---|---|---|
| `toSdkTool(Tool)` | nova → SDK | 构造 SDK 要求的 `SdkTool`，把 `readonly` required 复制成 mutable |
| `toSdkMessageParam(NovaMessage)` | nova → SDK | 消息转换，保持 `content` 的 string/array 两种形态 |
| `toSdkContentBlock(NovaContentBlock)` | nova → SDK | 块转换，`is_error === true` 时才写入 `is_error` 字段 |
| `fromSdkMessage(SdkMessage)` | SDK → nova | 只保留 `text` / `tool_use`，用 `isPlainObject` 守卫 `tool_use.input` |
| `mapStopReason(stop_reason)` | SDK → nova | `null` / `undefined` / 未知值一律当作 `END_TURN` 终止 loop |

这些函数都是纯函数（无 IO、无可变状态），可直接单测。

---

## 7. maxTurns 的边界行为

```ts
for (let turn = 1; turn <= config.maxTurns; turn += 1) {
  ...
}
throw new MaxTurnsExceededError(config.maxTurns);
```

- `maxTurns = 1`：单轮问答。若模型选择 `tool_use`，执行完工具就抛错（第 2 轮不允许）。
- `maxTurns = N`：最多 N 次 LLM 调用。loop 内部第 N 轮执行完工具后会再进入第 N+1 次迭代，检查 `turn <= N` 失败，跳出循环抛错。

---

## 8. 依赖边界

```
QueryEngine.ts
├─→ @anthropic-ai/sdk  (Anthropic / APIError / APIUserAbortError / Raw… / SdkMessage…)
├─→ config/config.ts    (ResolvedConfig)
├─→ errors/index.ts     (AbortError / MaxTurnsExceededError / ToolExecutionError)
├─→ services/api/client.ts (createAnthropicClient)
├─→ services/api/errors.ts (LLMApiError)
├─→ Tool.ts             (Tool 类型)
├─→ tools.ts            (findTool)
└─→ types/message.ts    (NovaMessage / NovaContentBlock / AgentEvent / Enums)
```

**不依赖**：`commands/` / `cli.ts` / 具体工具实现（`tools/BashTool/...` 从不被 import）。

---

## 9. 对齐与偏离

对齐 `claude-code/src/QueryEngine.ts` 的文件名与总体结构；`runAgentLoop` 没有对齐 claude-code 的 `query()` 函数签名——`query()` 是 M12+ 引入 `SessionHistory` / `CompactState` 之后的形状，当前 M1.5 还没有这些概念，强行对齐会引入大量空参数。

**故意剥离的 claude-code 特性**（见文件顶部注释）：

- compact / microcompact / context collapse（M4 再加）
- thinking / extended thinking 配置（M6+）
- fallback model / 多层 retry（`withRetry` 薄层已就绪但 loop 未强制使用）
- 权限审批（`requiresApproval` 字段只埋不读）
- hooks / analytics

---

## 10. 常见改动该怎么下手

| 需求 | 改哪里 |
|---|---|
| 新增一种停止原因（如 `safety_stop`） | `types/message.ts`（枚举）+ `QueryEngine.ts::mapStopReason` |
| 新增一种事件（如 `progress`） | `types/message.ts`（AgentEvent 联合）+ `QueryEngine.ts` 里合适位置 `yield` |
| 支持 vision（图片块） | `types/message.ts` 扩 `NovaContentBlock` + `QueryEngine.ts::toSdkContentBlock/fromSdkMessage` |
| 工具需要传 `cwd` | `Tool.ts::ToolExecutionContext` 扩字段 + `QueryEngine.ts::executeOneTool` 传入 |
| LLM 调用走重试 | 把 `client.messages.stream` 用 `withRetry` 包一层（注意：流式调用 retry 需要重建 stream，不只是 await）|
| 多条 system message | `AgentLoopParams.systemPrompt` 改成 `string \| readonly string[]` 并在请求处 join |

每次改完跑 `bun test src/QueryEngine.test.ts` 与 `bun test src/integration.test.ts`。
