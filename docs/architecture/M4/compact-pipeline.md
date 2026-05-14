# Compact 主路径与回退路径

## 1. 主路径 compactConversation

**位置**：`src/services/compact/compact.ts`
**入口**：`compactConversation(params: CompactConversationParams): Promise<CompactionResult>`

### 1.1 入参

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| messages | `readonly NovaMessage[]` | ✓ | 待压缩的对话历史；空数组 → 抛错 |
| client | `Anthropic` | ✓ | SDK 客户端（与 QueryEngine 共用） |
| model | `string` | ✓ | 模型名 |
| trigger | `"auto" \| "manual"` | ✓ | 决定 summary 是否含 "Continue the conversation" 段落 |
| customInstructions | `string?` | | 拼到 prompt 末尾的 Additional Instructions |
| signal | `AbortSignal?` | | Ctrl+C / timeout 中断 |
| llmLogSink | `CompactLogSink?` | | 写 compact_request / compact_response / compact_error |
| systemPrompt | `string?` | | 与主循环相同的 system prompt，用于 forked-agent prompt cache 共享 |
| sdkTools | `readonly SdkTool[]?` | | 与主循环相同的工具定义；配合 `tool_choice:none` 禁止 compact 实际调工具 |

### 1.2 流程

```
1. messages.length === 0 → throw ERROR_MESSAGE_NOT_ENOUGH_MESSAGES
2. preCompactTokenCount = tokenCountWithEstimation(messages)
3. 构造 LLM 请求：
     model: <input>
     max_tokens: 20_000  // MAX_OUTPUT_TOKENS_FOR_SUMMARY
     messages: [...messages, { role: USER, content: getCompactPrompt(customInstructions) }]
     system: <same as main loop>
     tools: <same as main loop>
     tool_choice: { type: "none" }  // 关键：复用 prompt cache，但硬禁工具调用
4. client.messages.stream(requestParams, { signal })
5. 消费流（compact 不渲染 text_delta；纯把流读完）
6. final = await stream.finalMessage()
   - APIUserAbortError 原样上抛（让上层按 abort 处理）
   - 其它异常 → 记 compact_error → 上抛
7. rawSummaryText = 把 final.content 里所有 text 块拼起来
   - 全空白 → throw ERROR_MESSAGE_INCOMPLETE_RESPONSE
8. summaryUserText = getCompactUserSummaryMessage(
     rawSummaryText,
     suppressFollowUpQuestions = (trigger === "auto"),
     recentMessagesPreserved = false,
   )
9. summaryMessage = { role: USER, content: summaryUserText }
10. postCompactTokenCount = roughTokenCountEstimationForMessages([summaryMessage])
11. 返回 CompactionResult
```

### 1.3 返回 CompactionResult

```ts
{
  summaryMessage: NovaMessage;          // 单条 user-role message，调用方用来替换 messages
  preCompactTokenCount: number;
  postCompactTokenCount: number;
  compactionUsage: ApiUsage;            // compact 这次调用本身的 usage（用于日志与调试）
  rawSummaryText: string;               // 模型原始 <summary> 内容（debug / e2e 用）
}
```

### 1.4 错误清单

| 常量 | 何时抛 | 调用方处理 |
|---|---|---|
| `ERROR_MESSAGE_NOT_ENOUGH_MESSAGES` | messages 空 | autoCompact 不会触发；ChatSession.compact 上抛给 /compact |
| `ERROR_MESSAGE_INCOMPLETE_RESPONSE` | 模型返回空文本 | autoCompact 计 1 次失败；/compact 上抛给用户 |
| `APIUserAbortError`（SDK 原生） | signal.aborted | 上抛给 runAgentLoop / runChatRepl 的 abort 处理 |
| 其它 `Error` | 网络 / 限流 / parsing | autoCompact 计 1 次失败；/compact 包装成 "/compact 失败：<msg>" 打到 stderr |

## 2. 回退路径 partialCompactConversation

**位置**：`src/services/compact/partialCompact.ts`
**触发**：M4 默认不启用；roadmap §M4 要求"主线 compact 后模型严重遗忘"时切换到本路径，作为失败信号回退方案。

### 2.1 与主路径的差异

| 维度 | 主路径 compactConversation | 回退路径 partialCompactConversation |
|---|---|---|
| 输入 | 全部 messages | messages + keepRecent（默认 5） |
| 模型看到 | 全部 messages + 压缩指令 | 仅 prefix + 压缩指令；尾部 keptMessages 不进 LLM |
| 替换语义 | messages = [summary] | messages = [summary, ...keptMessages] |
| recentMessagesPreserved 标志 | false | true（让模型知道还有原文紧随 summary 之后） |
| 提示模板 | BASE_COMPACT_PROMPT | PARTIAL_COMPACT_PROMPT |

### 2.2 切片算法

```
1. 扫 messages 找所有"用户原始输入"的下标 = roundBoundaries[]
   判定：role=USER 且 typeof content === "string"
   （tool_result wrapper 的 user message 不算新一轮）

2. boundaries.length <= keepRecent → throw NOT_ENOUGH_MESSAGES
3. splitIndex = boundaries[boundaries.length - keepRecent]
4. prefix = messages.slice(0, splitIndex)
   keptMessages = messages.slice(splitIndex)
5. LLM 请求 = [...prefix, summaryRequest]，只让模型看到前缀
6. 返回 { ...CompactionResult, keptMessages, splitIndex }
```

### 2.3 切片安全性

`splitIndex` 总是落在某个 user 文本输入位置，即新一轮的开头。这保证：
- prefix 末尾是上一轮的 assistant，不会留半截 tool_use
- keptMessages 头部是 user 文本，不是孤立的 tool_result
- API 请求合法（tool_use ↔ tool_result 配对完整）

## 3. Prompt 模板

**位置**：`src/services/compact/prompt.ts`

### 3.1 三段式

每个 prompt 都是 `NO_TOOLS_PREAMBLE + <主体> + NO_TOOLS_TRAILER`：

- **NO_TOOLS_PREAMBLE**：CRITICAL 提示模型只输出文本、不调工具
- **主体**：BASE_COMPACT_PROMPT（主路径）/ PARTIAL_COMPACT_PROMPT（回退路径）
  - 9 节 summary 结构（Primary Request / Key Concepts / Files / Errors / ...）
  - 要求 `<analysis>...</analysis><summary>...</summary>` 双 XML 标签
- **NO_TOOLS_TRAILER**：再次强调不要调用工具

### 3.2 formatCompactSummary

把模型原始输出处理成可塞回上下文的字符串：
1. 删去 `<analysis>...</analysis>` 段（仅是模型的草稿区）
2. `<summary>...</summary>` 替换成 `Summary:\n...` 易读形态
3. 多重空行折叠成单空行

### 3.3 getCompactUserSummaryMessage

构造塞回上下文的 user message 文本，三种形态组合：

| suppressFollowUpQuestions | recentMessagesPreserved | 输出形态 |
|---|---|---|
| false | false | 仅 base summary（手动 /compact，主路径） |
| false | true | base + "Recent messages are preserved verbatim." |
| true | false | base + "Continue the conversation from where it left off..." |
| true | true | base + 两行尾巴 |

## 4. 测试覆盖

- 主路径：`compact.test.ts` 10 用例（空 messages / 空响应 / abort / customInstructions / max_tokens / forked-agent tools + tool_choice / log sink）
- 回退路径：`partialCompact.test.ts` 5 用例（keepRecent 不足 / 切片正确 / prefix 进请求 / 默认值 / 入参校验）
- prompt：`prompt.test.ts` 12 用例（包括 strip / format / suppress flag）
- e2e：`m4-e2e-compact.test.ts` 用例 b / c 验证主路径在真正子进程 + mock server 下的端到端行为
