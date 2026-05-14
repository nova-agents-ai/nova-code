# 自动 compact：阈值 + usage 锚点 + circuit breaker

## 1. 阈值算式

**常量栈**（`src/services/compact/contextWindow.ts`）：

```
MODEL_CONTEXT_WINDOW_DEFAULT       200,000   ← 模型上下文窗口
MAX_OUTPUT_TOKENS_FOR_SUMMARY       20,000   ← compact 输出预留
AUTOCOMPACT_BUFFER_TOKENS           13,000   ← 安全余量

效用函数：
getContextWindowForModel(model)         = 200_000（M4 简化为查 claude 系全部 200K）
getEffectiveContextWindowSize(model)    = 200_000 - 20_000 = 180,000
getAutoCompactThreshold(model)          = 180_000 - 13_000 = 167,000
```

阈值 167K 与 claude-code 同款，确保有充足空间给 summary 输出 + 一些 buffer 给后续 turn 的 tool_result。

## 2. usage 锚点估算

**位置**：`src/services/compact/tokens.ts`

### 2.1 NovaMessage.usage

```ts
interface ApiUsage {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly output_tokens: number;
}

interface NovaMessage {
  readonly role: MessageRoleEnum;
  readonly content: string | readonly NovaContentBlock[];
  readonly usage?: ApiUsage;
}
```

QueryEngine 在每次 `streamOneTurn` 完成后，把 SDK `final.usage` 直接挂到返回的 assistant message 上：

```ts
const assistantMessage = {
  ...fromSdkMessage(final),
  usage: {
    input_tokens: final.usage.input_tokens,
    cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: final.usage.cache_read_input_tokens ?? null,
    output_tokens: final.usage.output_tokens,
  },
};
```

这和 claude-code 同款：token 计数不靠额外 side-channel state，而是从 messages 末尾向前找最近一条带 usage 的 assistant message。

### 2.2 tokenCountWithEstimation

```ts
function tokenCountWithEstimation(messages: readonly NovaMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.usage !== undefined) {
      return getTokenCountFromUsage(msg.usage) +
        roughTokenCountEstimationForMessages(messages.slice(i + 1));
    }
  }
  return roughTokenCountEstimationForMessages(messages);
}
```

### 2.3 chars/4 估算公式

```ts
function roughTokenCountEstimationForMessages(messages): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") totalChars += msg.content.length;
    else for (const block of msg.content) {
      if (block.type === "text")        totalChars += block.text.length;
      if (block.type === "tool_use")    totalChars += JSON.stringify(block.input).length + block.name.length;
      if (block.type === "tool_result") totalChars += block.content.length;
    }
  }
  return Math.ceil(totalChars / 4);
}
```

中英混合文本会偏低估（英文 4 字符 ≈ 1 token，中文 1 字符 ≈ 1 token）。M4 接受这个偏差：
- 用于阈值触发判定，偏低估意味着稍晚触发，对长对话不致命
- 最近一条 assistant usage 本身是精确值，估算只覆盖该 assistant 之后的"新增段"，偏差被局部化

## 3. shouldAutoCompact

**位置**：`src/services/compact/autoCompact.ts:71`

```ts
function shouldAutoCompact(params: {
  messages: readonly NovaMessage[];
  model: string;
  enabled: boolean;
}): boolean {
  if (!params.enabled) return false;
  if (params.messages.length === 0) return false;
  const tokenCount = tokenCountWithEstimation(params.messages);
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, params.model);
  return isAboveAutoCompactThreshold;
}
```

设计选择：**不在此函数里检查 circuit breaker**。breaker 在 `autoCompactIfNeeded` 内单独检查 —— 让 `shouldAutoCompact` 保持纯函数语义，方便单测穷举边界。

## 4. autoCompactIfNeeded：触发器主入口

**位置**：`src/services/compact/autoCompact.ts:139`

### 4.1 流程

```
1. enabled=false              → 返回 { wasCompacted: false }
2. tracking.consecutiveFailures >= 3   → 返回 { wasCompacted: false }（circuit breaker）
3. shouldAutoCompact 不通过   → 返回 { wasCompacted: false }
4. 真触发：
   try {
     result = await compactConversation({messages, client, model, trigger: "auto", ...})
     tracking.compacted = true
     tracking.turnCounter = 0
     tracking.consecutiveFailures = 0
     return { wasCompacted: true, summaryMessage, ...metrics }
   } catch (e) {
     if (e instanceof APIUserAbortError) throw e   // abort 上抛
     tracking.consecutiveFailures += 1
     return { wasCompacted: false, error: e.message }
   }
```

### 4.2 Circuit breaker 状态机

```
       ┌────────────────────────────────────────┐
       │                                        │
       ▼                                        │
  ┌────────────┐  失败    ┌────────────┐       │
  │ failures=0 │ ───────▶ │ failures=1 │       │
  └────────────┘          └────────────┘       │
       ▲ 成功                  │               │
       │                       ▼ 失败          │
       │                ┌────────────┐         │
       └────────────────│ failures=2 │         │
                  成功  └────────────┘         │
                              │                │
                              ▼ 失败          │
                       ┌────────────┐         │
                       │ failures=3 │         │
                       └────────────┘         │
                              │                │
                              ▼ 后续 turn 全部 │
                          STOPPED ─────────────┘
```

- 每次成功重置 `consecutiveFailures = 0`
- 每次失败 +1
- ≥ 3 时 `autoCompactIfNeeded` 直接返回 false，不再调 LLM
- **手动 /compact 不受 breaker 影响**：走的是 `ChatSession.compact()`，不读 tracking

### 4.3 失败为什么不直接抛错

如果上抛，整个 agent loop 就崩了，用户看到 chat 退出。但当前轮的 user prompt 还没被处理 —— 这违背"chat 应当鲁棒"的体感。

替代方案：失败 → continue → 下一轮 streamOneTurn 直接发请求 → 服务端可能回 `prompt_too_long` → 那时由 SDK 错误处理路径接管（M4 范围外）。这本质是把 compact 失败的硬错误转成"让 API 自己判定"的软回退。

## 5. tracking state 生命周期

**类型**：`AutoCompactTrackingState`（mutable struct）

```ts
interface AutoCompactTrackingState {
  compacted: boolean;
  turnCounter: number;
  consecutiveFailures: number;
}
```

### 5.1 谁创建

- chat REPL：`runChatRepl` 启动时 `createAutoCompactTrackingState()`，整个会话共用一份
- ask CLI：`runAskWithLLM` 启动时同上
- 库使用者：可自行 `createAutoCompactTrackingState()` 注入

### 5.2 谁更新

| 时机 | 更新内容 |
|---|---|
| `streamOneTurn` 完成 | assistant message 携带 `usage`；`turnCounter += 1` |
| `autoCompactIfNeeded` 成功 | `compacted = true`；`turnCounter = 0`；`consecutiveFailures = 0` |
| `autoCompactIfNeeded` 失败 | `consecutiveFailures += 1` |

### 5.3 跨 sendTurn 复用

ChatSession 每次 sendTurn 都把 tracking 透传给 runAgentLoop，所以 tracking 状态跨多 turn 累积 —— 这是必需的，否则每轮都从 fresh state 开始就违背了 circuit breaker 的语义。

## 6. 测试覆盖

- `autoCompact.test.ts` 12 条用例覆盖：
  - calculateTokenWarningState 阈值上下边界
  - shouldAutoCompact disabled / 空 messages / 阈值上下 / usage 携带超阈
  - autoCompactIfNeeded disabled / breaker 已触发 / 阈值之下 / 成功重置 / 失败 +1 / 3 次后停用
- `tokens.test.ts` 13 条覆盖 walk-back-from-end、cache 字段为 null、空数组、无 usage 降级
