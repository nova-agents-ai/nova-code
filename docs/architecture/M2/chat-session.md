# 02 · ChatSession —— 多轮对话的状态持有者

> 源码：[`src/commands/ChatCommand/ChatSession.ts`](../../../src/commands/ChatCommand/ChatSession.ts)
> 配套测试：`src/commands/ChatCommand/ChatSession.test.ts`

M2 最核心的抽象之一。读完本篇你应能回答：
- 为什么不把消息历史直接塞进 `runAgentLoop` 的闭包？
- "原子提交"具体怎么做？失败时如何回滚？
- ChatSession 与 QueryEngine 内部 messages 数组的关系？

## 1. 职责边界

ChatSession 只做三件事：

1. **持有 `messages: NovaMessage[]`** —— 严格遵循 `user → assistant → tool_result_user → ...` 配对链条。
2. **`sendTurn(userInput, ctx)`** —— 以当前 messages 为 initialMessages 跑一轮 `runAgentLoop`，通过订阅事件流**重建**本轮新增的消息，loop 全流程成功才一次性覆盖 `this.messages`。
3. **`clear / snapshot / restore`** —— 为 `/clear`、`/save`、`/load` 三条斜杠命令提供原子 API。

**不做的事**：
- 不做 I/O（所有 `print/stderr/stdout` 交给 `renderAgentEvent`）
- 不做 LLM 调用（委托 `runAgentLoop`）
- 不做持久化（委托 `sessionStore`）
- 不做参数校验（`assertSafeFileName` 在 sessionStore 侧，`restore` 这里约定调用方已校验过 JSONL 结构）

这种"只管内存状态 + 事件重建"的职责切分，让 ChatSession 能在 8 个单测里跑完全部路径——工具路径用 fake agentLoop 注入就能单测到，不碰 Anthropic SDK。

## 2. 类型与字段

```ts
interface SessionMeta {
  readonly sessionId: string;
  readonly model: string;
  readonly createdAt: string;   // ISO 8601
}

interface ChatTurnContext {
  readonly config: ResolvedConfig;
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  readonly agentLoop?: typeof runAgentLoop;  // 依赖注入，生产不传
  readonly llmLogSink?: LlmLogSink;          // debug 时透传
}

class ChatSession {
  private _meta: SessionMeta;
  private messages: NovaMessage[];
  // 公开 API 见 §5
}
```

`ChatTurnContext.agentLoop` 的存在理由：单测要把 `runAgentLoop` 换成 fake gen，避免碰真 SDK。写成 `typeof runAgentLoop` 能自动跟随签名演进。

## 3. 为什么"原子提交"是必需的

考虑这样一轮 sendTurn：

1. 用户发 `"用 echo 工具问好"`
2. 模型回复 `assistant { tool_use: echo "hi" }`（turn 1 结束）
3. 执行工具，正准备把 tool_result 打包回发
4. **此时用户按 Ctrl+C**
5. agent loop 抛 `AbortError`

如果 ChatSession 是"边走边追加"的写法：
```ts
// 反面教材
this.messages.push({ role:user, content:userInput });      // 追加了
// ...接 event 追加 assistant(tool_use) ...
this.messages.push(assistantMessageWithToolUse);           // 又追加了
// 抛 AbortError ↑↑↑
// 此时 this.messages 末尾是 [user, assistant(tool_use)]
// ⚠ 缺少对应的 tool_result user —— 下一轮发给 SDK 会被拒
```

下一轮 sendTurn 一进门就报错："tool_use with id=X has no corresponding tool_result"。且这份残缺状态不会自愈——除非用户手动 `/clear`。

**正确做法**：所有新追加的消息先进"本地副本" `newMessages`，只在 generator 正常耗尽（最后一个事件必是 done）之后才 `this.messages = newMessages`。抛错路径压根不会走到那一行，`this.messages` 保持调用前状态，下一轮继续可用。

## 4. sendTurn 的事件重建算法

```ts
async *sendTurn(userInput, ctx): AsyncGenerator<AgentEvent, void, void> {
  const newMessages = [...this.messages, { role: USER, content: userInput }];
  const initialMessages = [...this.messages];   // 传给 runAgentLoop（不含本轮 user）

  const gen = (ctx.agentLoop ?? runAgentLoop)({
    config: ctx.config,
    userPrompt: userInput,
    initialMessages,
    tools: ctx.tools,
    signal: ctx.signal,
    ...(ctx.llmLogSink !== undefined ? { llmLogSink: ctx.llmLogSink } : {}),
  });

  const pending: ToolResultBlock[] = [];

  for await (const event of gen) {
    switch (event.type) {
      case "turn_start":
        // 模型要回信前把上一批 tool_result 打包成单条 user message
        if (pending.length > 0) {
          newMessages.push({ role: USER, content: pending.splice(0) });
        }
        break;
      case "turn_end":
        newMessages.push(event.message);   // assistant message
        break;
      case "tool_result":
        pending.push({
          type: "tool_result",
          tool_use_id: event.toolUseId,
          content: event.content,
          ...(event.isError ? { is_error: true } : {}),
        });
        break;
      // text_delta / tool_call / done：不影响历史，只转发
    }
    yield event;
  }

  // 正常耗尽：原子提交
  this.messages = newMessages;
}
```

### 4.1 为什么在 `turn_start` 而非 `tool_result` 事件里 flush？

因为 QueryEngine 内部把 tool_result 打包发回模型是在 `executeToolsAndYieldEvents` **全部 tool_result 事件发完之后**、下一轮 `for turn` 迭代的 `messages.push` 那一步。`turn_start` 事件正好是下一轮迭代的第一个 yield——两边时机严格一致。

换句话说：ChatSession 的 `turn_start → flush pending` 对应 QueryEngine 的 `messages.push({role:user, content:toolResults})`；二者在同一时刻把"tool_result 批"合并成一条 user message。

### 4.2 为什么要拷贝 `initialMessages = [...this.messages]`？

`runAgentLoop` 内部会 `const messages = [...(params.initialMessages ?? []), {role:user,content:userPrompt}]`——已经做了拷贝。ChatSession 这里再拷一份是防御性冗余：即便未来 QueryEngine 改成共享引用，ChatSession 这层仍然安全。拷贝成本可忽略（浅拷贝指针数组）。

### 4.3 `pending.splice(0)` 的用意

`Array.prototype.splice(0)` 返回原数组被抽出的所有元素并清空原数组，等价于 `pending.slice(); pending.length = 0;` 的组合但只需一行。本轮的 pending 状态从此归零，等下一批 tool_result。

### 4.4 `is_error` 的可选写出

Anthropic SDK 的 `ToolResultBlockParam.is_error` 是可选字段（不写等价于 false）。ChatSession 遵循同样语义：只在 `event.isError === true` 时才写出 `is_error: true`，false 路径直接省略字段。这样：
- save 到 JSONL 后文件更干净（成功的 tool_result 不带 `"is_error":false` 噪音字段）
- SDK 往返语义严格一致

## 5. 对外 API

```ts
constructor(meta: SessionMeta, initialMessages?: readonly NovaMessage[])
```
构造新会话或从 `/load` 快照恢复。`initialMessages` 默认 `[]`。**不做结构校验**——约定来源 sessionStore 已经按字段走过一遍。

```ts
get meta(): SessionMeta
```
只读元信息。`/save` 写 JSONL 首行用得到。

```ts
sendTurn(userInput, ctx): AsyncGenerator<AgentEvent, void, void>
```
见 §4。注意返回类型是 `AsyncGenerator<AgentEvent, void>`——`void` 代表 generator 不返 value。`runAgentLoop` 自己是 `AsyncGenerator<AgentEvent, NovaMessage>`，ChatSession 这一层把返回值"吃掉"了（已经通过 `turn_end` 重建到 newMessages 里）。

```ts
clear(): void
```
`/clear` 命令用。仅置空 messages，保留 meta——`/clear` 后紧接 `/save` 仍写到同一个 sessionId.jsonl。

```ts
snapshot(): readonly NovaMessage[]
```
`/save` 命令用。**返回副本**（`[...this.messages]`），防止调用方意外污染内部状态。

```ts
restore(meta, messages): void
```
`/load` 命令用。整体替换 `_meta` 和 `messages`。同样不校验——sessionStore 已经按行 parse 过，结构是可信的。

## 6. 与 QueryEngine 的依赖方向

```
   ChatSession ──────import──────→  QueryEngine
        ↑                                ↑
        │ 不存在                         │ 不存在
        └─── import ────────── ChatSession (❌)
```

QueryEngine 不 import ChatSession（甚至不知道它存在）。这保证：
- QueryEngine 能被 ask 路径直接用，不被 chat 的会话语义绑死
- 未来加一个 bridge 子命令直接调 `runAgentLoop({initialMessages, userPrompt, ...})`，完全不需要 ChatSession

QueryEngine 里的 `LlmLogSink` 是个鸭子类型接口（只要求 `write`），ChatSession 把 `ctx.llmLogSink` 原样透传，**不做鉴权、不做再封装**——见 [llm-debug-log.md](./llm-debug-log.md)。

## 7. 测试覆盖速查

`ChatSession.test.ts` 的 11 个 case 全部走 fake agentLoop（yield 脚本化事件）。关键场景：

| 场景 | 断言 |
|---|---|
| 单轮 end_turn | snapshot = `[user, assistant]` |
| 连续两轮 | snapshot 顺序严格递增，不跳序 |
| tool_use → tool_result → end_turn | snapshot 呈 `user → assistant(tool_use) → user(tool_result) → assistant(text)` 的 4 条 |
| tool_result.isError=true | 重建的 tool_result block 带 `is_error: true` |
| LLM 抛错 | this.messages **完全不变**（rollback 验证） |
| tool_use 后未完成 tool_result 就抛错 | 同上，newMessages 全部丢弃 |
| clear / snapshot / restore | meta 保留、副本独立、恢复后可继续 sendTurn |

这一套测试是"事件重建规则是否与 QueryEngine 对齐"的黄金断言集——**任何改动 QueryEngine 内部 messages push 顺序的 PR 必须同步过一遍这套 test**。

## 8. 常见陷阱

- **不要在 sendTurn 的 `for await` 里 `throw` 重抛**：中间 throw 会跳过 `this.messages = newMessages`，这是设计，但别误以为"加个 try/catch 打个日志更鲁棒"——恰恰相反，吃掉异常会让 rollback 机制失效。
- **`snapshot()` 返回的是副本，`meta` 返回的是同一对象**：meta 是 readonly 的，直接暴露引用是安全的（SessionMeta 所有字段 readonly，不可变即可共享）。messages 数组是可变的（push/splice），必须返副本。
- **`restore()` 不会发出任何事件**：它只是状态替换。上层 `/load` 命令用 `io.print` 自己打印提示。
