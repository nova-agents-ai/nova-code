# M16 实现架构：持久化记忆系统（Auto Memory）

> 适用版本：M16 持久化记忆系统之后
>
> 面向对象：读 nova-code 代码的人；想知道 `src/services/memory/` 各模块如何拼装、QueryEngine 在哪些注入点用上记忆系统、与 M3/M11/M12 子系统如何协作。

---

## 1. 模块布局

```
src/services/memory/
├── types.ts              MemoryType / MemoryHeader / RelevantMemory / SurfacedMemory
├── promptText.ts         system prompt 文案常量（单一事实源）
├── frontmatter.ts        极简 --- ... --- parser
├── age.ts                memoryAge / memoryFreshnessText
├── paths.ts              getAutoMemPath / isAutoMemPath / isAutoMemoryEnabled / ensureMemoryDirExists
├── scan.ts               scanMemoryFiles / formatMemoryManifest
├── entrypoint.ts         truncateEntrypointContent (200 行 + 25KB 双门)
├── prompt.ts             buildMemoryLines / loadMemoryPrompt
├── relevance.ts          findRelevantMemories（LLM 二级调度）
├── extractor.ts          createMemoryExtractorFactory / hasMemoryWritesSince
├── memoryRuntime.ts      MemoryRuntime 聚合接口 + createMemoryRuntime
└── index.ts              re-exports
```

依赖方向（无环）：

```
types ────────────────────────────────────────────────┐
promptText ──► types                                  │
frontmatter (no deps)                                 ▼
age (no deps)                                       index.ts
paths (no deps)              ─────────────────────────►
entrypoint (no deps)                                  ▲
scan ──► paths + frontmatter + types                  │
prompt ──► paths + promptText + entrypoint            │
relevance ──► scan + types + Anthropic SDK            │
extractor ──► paths + scan + types + ResolvedConfig + Tool + NovaMessage
memoryRuntime ──► age + paths + prompt + relevance + types + NovaMessage
```

`extractor.ts` 故意 **不** import `QueryEngine` —— 通过 `RunAgentLoopFn` 类型参数注入运行时函数。这避免了 QueryEngine → MemoryRuntime → extractor → QueryEngine 的循环依赖。

---

## 2. 与 QueryEngine 的注入点

### 2.1 AgentLoopParams

`AgentLoopParams` 新增可选字段：

```ts
readonly memoryRuntime?: MemoryRuntime;
```

未注入时 QueryEngine 行为与 M15 完全一致（向后兼容）。

### 2.2 每轮 turn 顶端

```ts
for (let turn = 1; turn <= maxTurns; turn++) {
  await params.memoryRuntime?.refreshInstructions();   // ① refresh
  const systemPrompt = buildSystemPrompt({
    projectInstructions: mergeInstructionBlocks(
      params.planModeRuntime?.getSystemInstructions(),
      params.projectInstructionsRuntime?.getInstructions(),
      params.projectInstructions,                       // 含 skill listing
      params.memoryRuntime?.getInstructions(),          // ② memory 在末尾
    ),
  });
  ...
}
```

- `refreshInstructions()` 重新读 MEMORY.md：模型上一轮可能写过
- 顺序刻意把 memory 放在末尾：避免 ~5KB 的 memory 段把 skill listing / CLAUDE.md 推出 e2e mock 的 4KB observation 窗口

### 2.3 工具权限判定

```ts
const evalResult = evaluatePermission({
  ...,
  memoryDir: memoryRuntime?.memoryDir,   // ③ carve-out 入口
});
```

`permissionEngine` 在 bypass 之后、deny 规则之前增加 Step 3.5：

```
FileWrite / FileEdit 且 input.path 命中 isAutoMemPath(memoryDir) → allow
```

### 2.4 主 loop 结束

```ts
if (stopReason !== TOOL_USE) {
  void params.memoryRuntime?.runExtractorIfNeeded(messages);   // ④ fire-and-forget
  yield { type: "done", ... };
  return assistantMessage;
}
```

`void` 故意吃掉 Promise，不阻塞 generator 返回。extractor 内部有自己的 try/catch，永不冒泡。

---

## 3. 命令入口的接入

```
nova-code chat / ask
   ↓
createAnthropicClient(config) → sharedClient
   ↓
createMemoryRuntime({
  client: sharedClient,
  model, autoMemoryEnabled, cwd,
  extractorFactoryBuilder: (memoryDir) =>
    createMemoryExtractorFactory({ runAgentLoop, client: sharedClient, tools, memoryDir, signal }),
})
   ↓                              ↓
memoryRuntime.resolveRelevantMemories(userInput, signal)
   ↓
memoryRuntime.markSurfaced(memories)
   ↓
renderRelevantMemoriesAsSystemReminder(memories) → text block
   ↓
finalUserContent = [memory_reminder_block, ...resolvedPrompt.content]
   ↓
runAgentLoop({ ..., userMessageContent: finalUserContent, memoryRuntime })
```

`extractorFactoryBuilder` 是 builder pattern：runtime 内部解析 memoryDir 后再调一次，避免"上层先建 factory 又必须已知 memoryDir"的鸡蛋问题。

---

## 4. 数据流：写记忆

```
User: "我是 Go 工程师，请记下来"
   │
   ▼ chat.sendTurn(userInput)
runAgentLoop → 模型看到 system prompt 的 "# auto memory" 段
   │
   ▼ 模型决定调 FileWrite
tool_use { name: "FileWrite", input: { path: ".../memory/projects/X/user_role.md", ... } }
   │
   ▼ executeToolsAndYieldEvents
evaluatePermission(memoryDir=X) → Step 3.5 carve-out → allow ✅
   │
   ▼
FileWrite tool 执行，文件落盘
   │
   ▼ 模型继续调 FileEdit 把一行加到 MEMORY.md
（同上 carve-out 放行）
   │
   ▼ 模型 end_turn
   │
   ▼ QueryEngine 末端
memoryRuntime.runExtractorIfNeeded(messages)
   │
   ▼ hasMemoryWritesSince(messages, memoryDir) → true（主对话已写过）
extractor 跳过本轮 ✅（互斥避免重复）
   │
   ▼ 下一轮 turn 顶端
memoryRuntime.refreshInstructions() → 重新读 MEMORY.md → 含刚加的索引行
```

## 5. 数据流：读记忆

```
User: "解释 useEffect"
   │
   ▼ chat.sendTurn
memoryRuntime.resolveRelevantMemories(userInput, signal)
   │
   ▼ scanMemoryFiles(memoryDir) → MemoryHeader[]
   │   - readdir recursive → .md 文件（剔除 MEMORY.md）
   │   - 读前 8KB → parseMemoryDocument → frontmatter
   │   - 按 mtime 倒序，cap 200
   │
   ▼ findRelevantMemories
formatMemoryManifest(headers) → text manifest
client.messages.create({
  model, system: SELECT_PROMPT,
  user: "Query: explain useEffect\nAvailable memories:\n<manifest>",
  max_tokens: 256,
})
   │
   ▼ JSON parse "selected_memories": ["user_role.md", ...]
   │ 过滤非法 filename + alreadySurfaced
readSurfacedMemories(selected) → SurfacedMemory[]
   │   - readWithLimit(32KB) + memoryHeader + memoryFreshnessText
   │
   ▼ renderRelevantMemoriesAsSystemReminder
<system-reminder>
Memory (saved today): /path/user_role.md:
{content}
---
Memory (saved 2 days ago): /path/feedback_testing.md:
This memory is 2 days old. ... Verify against current code before asserting as fact.
{content}
</system-reminder>
   │
   ▼ 拼到 userMessageContent 前面
runAgentLoop({..., userMessageContent: [memoryBlock, ...attachments, userText]})
   │
   ▼ 模型接收：系统提示 + memory reminder + user query
   │ 基于记忆作答
```

---

## 6. 数据流：后台 extractor

```
主对话 end_turn 但主对话本轮 **没写过** memory
   │
   ▼ runExtractorIfNeeded(messages)
extractor 闭包：
   1. messages.length > lastProcessedIndex ✓
   2. newMessages.length >= EXTRACTOR_MIN_NEW_MESSAGES (4) ✓
   3. hasMemoryWritesSince(newMessages) → false ✓
   4. filteredTools = tools ∩ EXTRACTOR_TOOL_WHITELIST（Read/Grep/Glob/LS/Edit/Write）
   │
   ▼
existingMemoriesText = formatMemoryManifest(await scanMemoryFiles())
userPrompt = buildExtractorUserPrompt({
  newMessageCount, existingMemories: existingMemoriesText,
  parentContext: serializeParentContext(newMessages),  // 文本化注入
})
   │
   ▼ runAgentLoop (sub-agent)
   - config.maxTurns = 5
   - systemPrompt = EXTRACTOR_SYSTEM_PROMPT（"You are a memory extraction subagent..."）
   - tools = filteredTools
   - 不传 permissionStore/Provider → 默认全放行（安全靠 tool 白名单 + isAutoMemPath 守住路径）
   │
   ▼ 子 agent 跑 2-3 轮：
   - Turn 1: 并行 FileRead 所有可能要更新的 memory file
   - Turn 2: 并行 FileWrite 新文件 / FileEdit 现有文件 + 更新 MEMORY.md
   │
   ▼ drain events（不污染主转录）
extractor 闭包 return；下一轮主 loop 顶端 refreshInstructions 看到新写入
```

---

## 7. 与其它子系统的协作

| 子系统 | 协作方式 |
|---|---|
| M3 PermissionEngine | `evaluatePermission` 第 3.5 步 carve-out（memoryDir 内 FileWrite/FileEdit allow） |
| M4 Compact | 不冲突；memory section 是 system prompt 一部分，被 forked-agent cache 共享 |
| M9 Skills | 在 system prompt merge 顺序中：skill listing 在前、memory 在后 |
| M10 Hooks | extractor 子 agent 也会跑 PreToolUse / PostToolUse hooks（共享 tools 池），用户自定义 hook 仍生效 |
| M11 AgentTool | extractor 是 runAgentLoop 派生的 sub-agent，复用 M11 模式但不引入 forkedAgent 新设施 |
| M12 ProjectInstructions | merge 顺序中 ProjectInstructions 在前、memory 在后 |
| M14 Attachments | resolvedPrompt.content 中的附件 block 仍保留；memory reminder block 前置 |
| M15 Plan Mode | Plan Mode 拦截在 carve-out **之前**：plan 阶段写 memory 也被拦（与 plan 语义一致） |

---

## 8. 关键函数索引

| 函数 | 位置 | 作用 |
|---|---|---|
| `createMemoryRuntime` | memoryRuntime.ts:79 | 工厂，命令入口启动时调一次 |
| `MemoryRuntime.getInstructions()` | memoryRuntime.ts:46 | 同步返回 system prompt 段 |
| `MemoryRuntime.refreshInstructions()` | memoryRuntime.ts:48 | 异步重读 MEMORY.md |
| `MemoryRuntime.resolveRelevantMemories()` | memoryRuntime.ts:50 | per-turn LLM 召回 |
| `MemoryRuntime.runExtractorIfNeeded()` | memoryRuntime.ts:54 | 端 turn 触发 extractor |
| `findRelevantMemories` | relevance.ts:48 | 调 LLM 选 ≤5 个相关 memory |
| `createMemoryExtractorFactory` | extractor.ts:81 | 构造 extractor 闭包 |
| `hasMemoryWritesSince` | extractor.ts:154 | 主对话本轮是否已写 memory |
| `getAutoMemPath` | paths.ts:76 | 解析记忆目录（git root 优先，cwd 回退） |
| `isAutoMemPath` | paths.ts:159 | 权限 carve-out 用 |
| `scanMemoryFiles` | scan.ts:40 | 递归扫 .md + frontmatter + mtime 排序 |
| `loadMemoryPrompt` | prompt.ts:84 | 装配完整 system prompt 段 + MEMORY.md 内容 |
| `truncateEntrypointContent` | entrypoint.ts:31 | 200 行 / 25KB 双门 |

---

## 9. 测试矩阵

| 测试文件 | 覆盖 |
|---|---|
| `paths.test.ts` | git root / cwd 回退 / sanitize / env override / `..` 越狱拒绝 |
| `frontmatter.test.ts` | 基本三段 / 缺闭合 / 中文 / CRLF / 引号脱掉 |
| `age.test.ts` | today / yesterday / N days / 时钟漂移夹住 / fresh 返回空 |
| `entrypoint.test.ts` | 行数门 / 字节门 / 双门 / warning 文案 |
| `scan.test.ts` | 递归扫 / 剔除 MEMORY.md / 倒序 / cap 200 / 不存在返回空 |
| `prompt.test.ts` | 含 4 type / 含 MEMORY.md / empty 降级 / 截断 warning |
| `relevance.test.ts` | mock client / JSON parse 容错 / 散文包裹 / 非法 filename 过滤 / abort / max 5 |
| `extractor.test.ts` | hasMemoryWritesSince / 白名单 / 短交互节流 / 游标推进 / 异常吞 |
| `memoryRuntime.test.ts` | disabled / enabled / refresh / surface 去重 / extractor builder |
| `QueryEngine.test.ts` (追加) | system prompt 含 instructions / refresh 每轮调 / extractor 触发 / carve-out 放行 |
| `permissionEngine.test.ts` (追加) | carve-out 在 plan/bypass/deny 各 mode 下行为 / 相对路径 / `..` 越狱拒绝 |
| `m16-e2e-memory.test.ts` | 子进程：默认开 / 预置 MEMORY.md 加载 / env 关闭后不含 memory 段 |

合计 90+ 新增测试。

---

## 10. 配置与环境变量

| 字段 / 变量 | 类型 | 默认 | 来源 |
|---|---|---|---|
| `autoMemoryEnabled` | boolean | `true` | `~/.nova-code/config.json` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `"1"/"true"/"yes"` | 不设 | 环境变量 |
| `NOVA_MEMORY_DIR` | path | `~/.nova-code/memory` | 环境变量 |

启用优先级：env 关 > config 关 > 默认开。

---

## 11. 已知限制

1. **selector model 与主 model 共用**：当前 relevance 调用复用 `config.model`（Sonnet 等价物）；M17 多 provider 后再分层换 Haiku。
2. **extractor 不共享 prompt cache**：复用 M11 sub-agent 模式，每次 extractor 是完整 cache miss；claude-code 用 forkedAgent + cacheSafeParams 共享 cache prefix。后续可独立优化。
3. **不支持团队记忆同步**：M16 单用户记忆。team memory 留作后续 milestone。
4. **无并发 chat 进程写 MEMORY.md 互斥**：与 claude-code 同款，留作后续优化。
5. **memory 写权 carve-out 仅对 FileWrite / FileEdit**：模型若用 Bash `echo >> memory_file` 仍走 Bash 权限规则。

---

## 12. 交叉引用

- [M16 设计文档](../design/M16-memory.md)
- [M16 使用手册](../manual/M16-usage-guide.md)
- [Roadmap](../roadmap.md)
- [M3 权限架构](./M3/README.md)
- [M11 架构](./M11-architecture.md)
- [M12 架构](./M12-architecture.md)
- [M14 架构](./M14-architecture.md)
- [M15 架构](./M15-architecture.md)
