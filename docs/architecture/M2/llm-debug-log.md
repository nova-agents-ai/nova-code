# LLM 调用日志（llmLogSink）

对应源文件：[QueryEngine.ts](../../../src/QueryEngine.ts) +
[AskCommand/debugSink.ts](../../../src/commands/AskCommand/debugSink.ts)（M2 扩展）+
[AskCommand/runAskWithLLM.ts](../../../src/commands/AskCommand/runAskWithLLM.ts)。

M2 在已有的 AgentEvent 日志（M1.5）之上，**新增一条独立的"原始 LLM 请求/响应"日志链**，
让排障时能拿到 SDK 实际发出和收到的 payload，而不是只看经过 QueryEngine 映射后的事件流。

---

## 1. 为什么要两条日志

M1.5 的 --debug 日志只写 AgentEvent（text_delta / tool_call / tool_result / turn_end
等），这些都是 QueryEngine 已经做过**语义提纯**的事件。排障时常常需要回答：

- 请求时我们到底发了哪些 message？system prompt 是什么？tools 的 JSON schema 是什么？
- SDK 返回的原始 stop_reason 是什么？是 `end_turn` / `tool_use` / 还是别的？
- 错误发生在流的第几 turn？持续了多久？

这些答案都**不在 AgentEvent 里**。M2 把它们收进独立的 LLM 日志，留给真正排障的人看。

日志分层的好处：
- AgentEvent log → 回答"我给用户展示了什么"
- LLM log → 回答"我和 Anthropic API 之间发生了什么"
- 各取所需，文件不互相挤压

---

## 2. LlmLogSink 接口 —— 鸭子类型即可

在 [QueryEngine.ts](../../../src/QueryEngine.ts#L64) 定义：

```ts
export interface LlmLogSink {
  readonly write: (payload: unknown) => void;
}
```

只有一个 `write` 方法 —— **故意不 import `DebugSink`**：

| 方案 | 问题 |
|------|------|
| QueryEngine 直接 import `commands/AskCommand/debugSink.ts` 的 DebugSink | QueryEngine 位在顶层（`src/`），不应依赖 `commands/` 子目录 |
| 新建一个 `src/logging/LlmLogSink.ts` 再让 DebugSink 去 implements | 额外抽象；当前只有一个实现，过度设计 |
| **鸭子类型最小接口** | QueryEngine 只用 `write`，TypeScript 结构型兼容自动让 DebugSink 满足 LlmLogSink |

选后者。`createFileDebugSink` 返回值的 `write: (p: unknown) => void` 刚好匹配 LlmLogSink 的形状，
无需任何 adapter。

---

## 3. 三类事件

[streamOneTurn](../../../src/QueryEngine.ts) 在 LLM 交互的三个关键点写日志：

### 3.1 `llm_request` —— 发请求前

```ts
llmLogSink.write({
  kind: "llm_request",
  turn,
  model: config.model,
  params: requestParams,   // { model, max_tokens, system, messages, tools? }
});
```

记录**完整的 SDK 请求体**，可以直接照抄到 curl 复现问题。

### 3.2 `llm_response` —— 流结束后

```ts
llmLogSink.write({
  kind: "llm_response",
  turn,
  model: config.model,
  stopReason: final.stop_reason,          // SDK 原始值（未经 mapStopReason）
  durationMs: Date.now() - startedAt,
  message: final,                         // SDK 的 finalMessage 完整对象
});
```

注意 `stopReason` 是 **SDK 原始字符串**（`end_turn` / `tool_use` / `max_tokens` / `stop_sequence`），
没走 `mapStopReason` 的映射 —— 排障时这个信息比映射后的 `AgentStopReasonEnum` 更直接。

### 3.3 `llm_error` —— 流异常或 finalMessage 异常

```ts
// 统一通过 writeLlmError 帮手函数
function writeLlmError(sink, turn, durationMs, error) {
  if (sink === undefined) return;
  sink.write({
    kind: "llm_error",
    turn,
    durationMs,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
}
```

两处调用：
1. `for await (stream)` 抛异常时（网络断 / SDK 内部错）
2. `await stream.finalMessage()` 抛异常时（流结束但消息异常）

**在 `throw normalizeSdkError(error)` 之前记录**，保证日志里看到的是原始错误、不是包装过的。

---

## 4. Fail-safe：日志失败不阻断 LLM 调用

所有三处 `llmLogSink.write(...)` 都包在 try/catch 里：

```ts
if (llmLogSink !== undefined) {
  try {
    llmLogSink.write({ kind: "llm_request", ... });
  } catch {
    // sink 内部已做降级；再抛无意义
  }
}
```

设计意图：

- 日志是**可观测性**而非**正确性**，不能因为盘满/fd 耗尽就把对话搞挂
- `createFileDebugSink` 内部已有一层降级（写失败只 print 警告，不抛）
- 外层再兜一次 catch 是防御性冗余 —— 万一上层传了不守规矩的 sink 实现

一次性 fail-safe，双重保险成本可忽略。

---

## 5. debugSink 的 prefix + sessionId 扩展

原 [createFileDebugSink](../../../src/commands/AskCommand/debugSink.ts) 在 M1.5 只支持 `pretty` 一个参数，M2 扩了两个：

```ts
interface CreateFileDebugSinkOptions {
  readonly pretty: boolean;
  readonly sessionId?: string;     // M2 新增
  readonly prefix?: string;        // M2 新增；默认 "ask"
}
```

文件名生成 [buildDebugLogFileName](../../../src/commands/AskCommand/debugSink.ts) 的矩阵：

| prefix | sessionId | 文件名形态 | 使用场景 |
|--------|-----------|-----------|---------|
| `"ask"` (默认) | 未传 | `ask-2026-05-04T14-23-07-<pid>.log` | ask 子命令 AgentEvent 日志（M1.5 形态，向后兼容） |
| `"ask-llm"` | 未传 | `ask-llm-2026-05-04T14-23-07-<pid>.log` | ask 子命令 LLM 原始日志（M2 新增） |
| `"chat"` | sessionId | `chat-2026-05-04T14-23-07-<sid>.log` | chat REPL AgentEvent 日志 |
| `"chat-llm"` | sessionId | `chat-llm-2026-05-04T14-23-07-<sid>.log` | chat REPL LLM 原始日志 |

两条约定：

1. **chat 用 sessionId 代替 pid 作后缀**：REPL 一进程承载多会话，sessionId
   比 pid 更有标识意义；而且与 sessions/*.jsonl 同 id 方便对比
2. **ask 保留 pid 后缀**：M1.5 建立的文件名规范，不破坏

这些都在 [buildDebugLogFileName](../../../src/commands/AskCommand/debugSink.ts) 一个 16 行的纯函数里，方便单测。

---

## 6. 调用点串联

### 6.1 chat 路径

```
ChatCommand.ts:
  const debugSink    = debug ? createFileDebugSink({ prefix: "chat",     sessionId, pretty }) : NULL
  const llmLogSink   = debug ? createFileDebugSink({ prefix: "chat-llm", sessionId, pretty }) : NULL

  runChatRepl({ session, config, tools, debugSink, llmLogSink: debug ? llmLogSink : undefined })

runChatRepl.ts:
  session.sendTurn(input, { config, tools, signal, llmLogSink })
                                            ↓
ChatSession.ts:
  agentLoop({ config, userPrompt, initialMessages, tools, signal, llmLogSink })
                                                                    ↓
QueryEngine.ts (runAgentLoop → streamOneTurn):
  llmLogSink.write({ kind: "llm_request"  | "llm_response" | "llm_error", ... })
```

注意 runChatRepl 传给 sendTurn 时用条件扩展：
```ts
...(llmLogSink !== undefined ? { llmLogSink } : {}),
```

—— 未开 debug 时根本不设此字段，让 `ChatTurnContext.llmLogSink?: LlmLogSink`
的 optional 类型干净匹配 `exactOptionalPropertyTypes` 配置。

### 6.2 ask 路径

```
runAskWithLLM.ts:
  const debugSink   = debug ? createFileDebugSink({ prefix: "ask",      pretty }) : NULL
  const llmLogSink  = debug ? createFileDebugSink({ prefix: "ask-llm",  pretty }) : NULL

  runAgentLoop({ config, userPrompt, tools, signal, llmLogSink })
```

ask 不传 sessionId，所以 llm log 文件名仍以 pid 结尾，保持 M1.5 建立的惯例。

---

## 7. initialMessages：多轮上下文的最小改动

LLM 日志之外，QueryEngine 在 M2 还做了另一处关键改动 ——
给 [AgentLoopParams](../../../src/QueryEngine.ts) 加了 `initialMessages`：

```ts
interface AgentLoopParams {
  readonly userPrompt: string;
  readonly initialMessages?: readonly NovaMessage[];   // M2 新增
  ...
}
```

使用点：

```ts
// runAgentLoop 内部
const messages: NovaMessage[] = [
  ...(params.initialMessages ?? []),     // 历史在前
  { role: "user", content: userPrompt }, // 本轮用户输入末尾追加
];
```

设计动机：

- **ask 单 shot 不传** → `initialMessages ?? []` 是空数组，行为与 M1.5 完全等同，零回归风险
- **chat 每轮传** → ChatSession 把 `this.messages` 的快照作为 initialMessages 交上去，
  LLM 得以看到完整历史，才能做多轮对话
- **约束**：调用方保证 initialMessages 已经是合法对话序列（user → assistant → user(tool_result) → ...
  配对）。runAgentLoop 不做校验；若序列错，Anthropic SDK 会在 request 阶段拒绝并报明确错误。
  把校验责任留给 ChatSession 的"原子提交"机制（见 [chat-session.md](./chat-session.md)）

这个改动**不动 QueryEngine 的返回类型、不动 AgentEvent 定义、不动 runAgentLoop 的主循环**；
只是把 `messages` 数组的初值换了一个来源。是典型的"最小侵入式扩展"。

---

## 8. PUA Sentinel 回顾（pretty 模式）

这是 M1.5 引入的技巧，M2 仍在用，补记在此便于读者理解为什么 pretty 模式能看到真换行。

问题：`JSON.stringify` 会把字符串内的 `\n` / `\t` / `\r` 转义成字面量 `"\\n"` / `"\\t"` / `"\\r"`，
导致 pretty 模式下 tool 输出的多行内容都挤成一行看不清。

想法：先把字符串值里的换行替换成稀有 sentinel，stringify 完再还原为真字节。
这样 JSON 的引号/键名/缩进结构仍由 stringify 正确生成，但内嵌字符串能看到真换行。

sentinel 选择必须满足：
1. 不出现在正常文本中
2. 不被 `JSON.stringify` 强制转义

**C0 控制字符（U+0000–U+001F）不行** —— JSON 规范强制把它们转义成 `\uXXXX`，
6 个可见字符；stringify 之后用原始字节 `replaceAll` 匹配不到，换行还原就失效了。

**Unicode 私有使用区（PUA，U+E000）** 满足两条：
- U+E000 在常规文本中几乎不会出现
- 不在 JSON 强制转义范围

所以实现用 `\uE000NL\uE000`、`\uE000TAB\uE000`、`\uE000CR\uE000` 三个 sentinel：

```ts
const NEWLINE_SENTINEL = "\uE000NL\uE000";
const TAB_SENTINEL     = "\uE000TAB\uE000";
const CR_SENTINEL      = "\uE000CR\uE000";

const replacer = (_key, value) => {
  if (typeof value !== "string") return value;
  return value
    .replaceAll("\r\n", NEWLINE_SENTINEL)
    .replaceAll("\n",   NEWLINE_SENTINEL)
    .replaceAll("\r",   CR_SENTINEL)
    .replaceAll("\t",   TAB_SENTINEL);
};

const json = JSON.stringify(payload, replacer, 2);
return json
  .replaceAll(NEWLINE_SENTINEL, "\n")
  .replaceAll(CR_SENTINEL,      "\r")
  .replaceAll(TAB_SENTINEL,     "\t");
```

这也是 LLM 日志 pretty 模式能直接 `cat` 看清 messages[].content 的底层支撑：
原本嵌套 JSON 字符串里的 \n 会炸成真换行，扫读舒服很多。

---

## 9. 测试覆盖

- [QueryEngine.test.ts](../../../src/QueryEngine.test.ts)：
  - 注入一个 in-memory LlmLogSink，驱动一轮假 agent loop（mock Anthropic client）
  - 断言三类事件都被写入 + 字段齐全（turn / model / durationMs / stopReason ...）
  - fail-safe：sink.write 抛错时 loop 仍能正常返回
  - initialMessages：传入历史后第一条请求的 messages 数组前置了这些历史
- [buildDebugLogFileName](../../../src/commands/AskCommand/debugSink.test.ts) 已覆盖四象限矩阵（prefix × sessionId）
- e2e：chat 启 --debug 后断言 `~/.nova-code/logs/` 下同时出现两个文件

---

## 10. 下一步 / 扩展点

M2 的日志体系已能回答绝大多数"API 层"排障问题，后续可能的扩展：

- **日志轮转**：超过 N MB 自动切分（当前一会话一文件，对长会话日志可能过大）
- **structured log aggregator**：把 llm_request/response 结构化为标准 JSON schema，
  便于喂给 OTel / Loki 等（可以走 DebugSink 的另一个实现，不改 QueryEngine）
- **/log 斜杠命令**：REPL 内打印当前两份日志文件的路径（目前只在启动时提示一次）
- **redaction**：在写入前对 params.messages 做敏感信息脱敏（当前全量记录）

以上都不需要改 QueryEngine 本身，只要替换 sink 实现 —— LlmLogSink 接口就是为此保留的解耦点。
