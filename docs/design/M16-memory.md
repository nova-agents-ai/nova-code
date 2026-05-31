# M16 — 持久化记忆系统（Auto Memory）

> 实施日期：2026-05-25
>
> 目标：在 `chat` / `ask` 之间为模型提供跨会话的项目级记忆能力，对齐 claude-code `src/memdir/` 的核心交互式行为。

---

## 1. 设计总览

M16 在 nova-code 中引入"纯文件系统 + LLM 二级调度"的记忆系统。核心三件套：

- **存储**：`~/.nova-code/memory/projects/<sanitize(git-root|cwd)>/` 目录，里面是若干带 frontmatter 的 `.md` 文件 + 一个 `MEMORY.md` 索引。
- **写入**：两条路径并存——①主对话用 `FileWrite`/`FileEdit` 直接落盘（权限 carve-out 跳过审批）；②每轮结束后后台 `extractor` subagent 兜底提取。
- **读取**：两条路径并存——①`MEMORY.md` 整文件常驻 system prompt；②每轮 user 提问时异步 sideQuery 从 frontmatter manifest 中挑出 ≤5 条 topic 文件作为 `<system-reminder>` 注入。

```
                       (chat REPL / ask, per user input)
 user input ──┬─► memoryRuntime.resolveRelevantMemories
              │        │
              │        ├─► scanMemoryFiles(memoryDir)  →  MemoryHeader[]
              │        ├─► sideQuery(model, SELECT_PROMPT, manifest)
              │        │     └─► JSON {selected_memories: string[]}
              │        └─► readMemoriesForSurfacing → RelevantMemory[]
              │
              ▼
       userMessageContent = [text(原 input), text("<system-reminder>Memory: ...")]
              │
              ▼
       runAgentLoop({ ..., userMessageContent, memoryRuntime })
              │
       每轮 buildSystemPrompt 合并 memoryRuntime.getInstructions()
       含：4 type 指令 + how-to-save + when-to-access + MEMORY.md 内容
              │
              ▼
       主对话（模型可能 FileWrite/FileEdit 落盘到 memoryDir）
              │
              ▼ stopReason !== TOOL_USE
       memoryRuntime.runExtractorIfNeeded(messages)
              │
              ├─ hasMemoryWritesSince() ? 跳过
              └─ spawn 受限 subagent（Read/Grep/Glob/LS + Edit/Write 限定 memoryDir）
                    · 静默返回（不污染主转录）
```

设计原则：**记忆指令是模型行为约束，不是工具机制**。M16 不引入新的 `Memory` tool；模型直接复用 `FileWrite`/`FileEdit`，由 system prompt 的 `## How to save memories` 段教会模型何时该写、写到哪、写成什么 frontmatter。

---

## 2. 新增模块

| 模块 | 职责 |
|---|---|
| `src/services/memory/types.ts` | `MemoryType` enum、`MemoryHeader`、`RelevantMemory`、运行时入参类型 |
| `src/services/memory/paths.ts` | `getMemoryBaseDir()` / `getAutoMemPath()`（git root → cwd 回退 + sanitize）/ `getAutoMemEntrypoint()` / `isAutoMemoryEnabled()` / `isAutoMemPath()` / `ensureMemoryDirExists()` |
| `src/services/memory/promptText.ts` | `TYPES_SECTION_INDIVIDUAL` / `WHAT_NOT_TO_SAVE_SECTION` / `WHEN_TO_ACCESS_SECTION` / `MEMORY_FRONTMATTER_EXAMPLE` / `TRUSTING_RECALL_SECTION` 等 system prompt 文案常量（与 claude-code `memoryTypes.ts` 同名映射） |
| `src/services/memory/frontmatter.ts` | 极简 `---\n...\n---` parser（不引 yaml 依赖） |
| `src/services/memory/age.ts` | `memoryAge` / `memoryFreshnessText` / `memoryFreshnessNote` |
| `src/services/memory/scan.ts` | `scanMemoryFiles(memoryDir, signal)`：递归 readdir → 取每个文件前 30 行 → parseFrontmatter → 按 mtime 倒序，≤200 个；`formatMemoryManifest()` |
| `src/services/memory/entrypoint.ts` | `truncateEntrypointContent()`（200 行 + 25KB 双门 + warning 后缀） |
| `src/services/memory/prompt.ts` | `buildMemoryLines()` + `loadMemoryPrompt()`：拼装完整 system prompt 段（4 type 指令 + MEMORY.md 内容） |
| `src/services/memory/relevance.ts` | `findRelevantMemories(query, memoryDir, signal, recentTools, alreadySurfaced)`：调 Anthropic Messages API（JSON 文本输出 + parse fallback）→ `RelevantMemory[]` |
| `src/services/memory/extractor.ts` | `runMemoryExtractor()` 复用 `runAgentLoop` 派生受限子 agent；`hasMemoryWritesSince()` 互斥；`buildExtractorPrompt()` |
| `src/services/memory/memoryRuntime.ts` | `MemoryRuntime`：聚合上述能力的会话级 runtime；`getInstructions()` / `resolveRelevantMemories()` / `runExtractorIfNeeded()` / `markSurfaced()` |
| `src/services/memory/index.ts` | re-exports |

`MemoryRuntime` 被注入 `runAgentLoop` 与 `ChatSession.sendTurn()` / ask 入口；这样 system prompt 装配、user content 拼装、turn-end extractor 都读同一个状态源。

---

## 3. 记忆类型与 frontmatter

四类记忆，对齐 claude-code 严格的"代码不可推导边界"：

| Type | 用途 | 例子 |
|---|---|---|
| `user` | 用户角色 / 偏好 / 知识背景 | "user 是 Go 资深工程师，首次接触本项目 React 端" |
| `feedback` | 用户给过的纠正 / 确认（必含 Why + How to apply） | "测试禁止 mock 数据库，原因：上季度 mock 测试通过但 prod 迁移失败" |
| `project` | 工作进展 / 决策 / 里程碑（必含绝对日期） | "2026-03-05 起冻结非关键合并：mobile 团队切 release 分支" |
| `reference` | 外部系统指针（Linear / Slack / Grafana 等） | "pipeline 缺陷追踪在 Linear 'INGEST' 项目" |

**禁止保存**（即使用户显式要求也要拒绝）：代码模式 / 架构 / 文件路径 / git 历史 / 调试 fix recipe / CLAUDE.md 已涵盖内容 / 临时任务状态。

记忆文件 frontmatter 格式：

```markdown
---
name: feedback-test-policy
description: integration tests must hit real database, never mocks
type: feedback
---

不要 mock 数据库。
**Why:** 上季度 mock 测试通过但 prod 迁移失败。
**How to apply:** 任何需要 DB 的 e2e / 集成测试用本地容器，不用 jest.mock。
```

`MEMORY.md` 是索引（无 frontmatter），每行一条 `- [Title](file.md) — one-line hook`，硬限 200 行 / 25 KB，超限截断并尾插 warning。

---

## 4. 目录与 scope 策略

```
getMemoryBaseDir()    = process.env.NOVA_MEMORY_DIR ?? ~/.nova-code/memory
getAutoMemPath()      = <base>/projects/<sanitize(getAutoMemBase())>/
getAutoMemBase()      = findCanonicalGitRoot(cwd) ?? cwd
getAutoMemEntrypoint() = <auto-mem-path>/MEMORY.md
```

git root 优先让同一仓库不同 worktree 共享一份记忆；非 git 目录（scratch / demo）回退到 cwd。`sanitize()` 把绝对路径转成单层目录名（替换 `/` 为 `-`，与 nova-code 现有 sessionId / mcp server-name sanitize 风格一致）。

启用门控（按优先级）：

1. `process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` → 关
2. `PersistedConfig.autoMemoryEnabled === false` → 关
3. 默认 → 开

---

## 5. 相关性召回机制

`findRelevantMemories(query, memoryDir, signal, recentTools, alreadySurfaced)`：

1. `scanMemoryFiles()` 拿到所有 topic 文件的 `MemoryHeader[]`（filename / mtimeMs / description / type）。
2. `formatMemoryManifest()` 拼成 LLM-friendly 清单 `- [type] file.md (ISO ts): description`。
3. 调 Anthropic Messages API（system prompt = `SELECT_MEMORIES_SYSTEM_PROMPT`，user = `Query: ... \n\nAvailable memories:\n<manifest>\n\nRecently used tools: ...`），`max_tokens=256`。
4. 解析返回文本里的 JSON `{"selected_memories": ["a.md","b.md"]}`，过滤非法 filename 与超限（最多 5 条）。
5. `readMemoriesForSurfacing()` 真读文件内容，返回 `{path, content, mtimeMs, header}`。
6. 已在前几轮注入过的文件路径（`alreadySurfaced`）在送 selector 前就过滤掉，节省 5 个 slot。

`recentTools`（最近成功调用的工具名）让 selector 跳过"正在被使用的工具的 reference 文档"。

注入路径：每条相关 memory 被包装成 `<system-reminder>Memory (saved 2 days ago): /path/...:\n\n<content>\n</system-reminder>`，作为 user content 的一个 text block 附加在原始 user input 之后；>1 天的文件 header 改成 `memoryFreshnessText` 的告诫文本。

---

## 6. 后台 extractor

每轮主对话结束（`stopReason !== TOOL_USE`）时触发，但满足以下任一条件即跳过：

- `hasMemoryWritesSince(messages, cursor)`：本轮主对话已经 `FileWrite`/`FileEdit` 写过 memory，不重复
- `MemoryRuntime` 未启用或被环境变量关闭
- 上次 extractor 处理的 cursor 等于当前 messages 末端（无新消息）

复用 `runAgentLoop` 派生子 agent（**不引入新的 forkedAgent 基础设施**）：

- 派生 prompt：`buildExtractorPrompt` 告诉子 agent "你只看最后 ~N 条消息；不要再 grep/git 验证；先并行 read，再并行 write"
- 工具白名单：`Read`、`Grep`、`Glob`、`LS`、只读 `Bash` 子集（ls/find/cat/stat/wc/head/tail）、`FileEdit`/`FileWrite` 限定 `isAutoMemPath()` 命中的路径
- `maxTurns: 5` 防止 verification rabbit-hole
- 静默返回（不写入主转录）

实现上通过 `MemoryRuntime` 持有的 `extractorFactory: () => Promise<void>` 闭包包装 `runAgentLoop`；factory 由命令入口（`AskCommand`/`ChatCommand`）注入，runtime 本身不直接依赖 `runAgentLoop`（避免与 QueryEngine 形成循环依赖）。

---

## 7. 权限 carve-out

`permissionEngine.ts` 在第 4 步 deny 规则之前、第 5 步 allow/ask 规则之前增加：

```ts
// Step 3b: memory directory carve-out
if (isFileWriteToolName(toolName)) {
  const filePath = extractFilePath(toolInput);
  if (filePath !== undefined && isAutoMemPath(resolve(cwd, filePath))) {
    return { decision: "allow", reason: "auto memory directory carve-out" };
  }
}
```

放在 plan mode 之后是为了让 Plan Mode 仍能拦截写权工具（即使是写 memory）；放在 deny / allow 规则之前是为了避免用户全局 deny 把 memory 写入也封掉。

安全边界：
- 仅对 `FileWrite` / `FileEdit` 工具名匹配（不影响 Bash / 其它）
- `isAutoMemPath()` 用 `path.normalize()` 防 `..` 越狱
- carve-out 不绕过 DENY_PATTERNS（即使 Bash 命令试图写 memory 也会被 DENY_PATTERNS 拦）

---

## 8. 与 claude-code 的差异

| 维度 | claude-code | nova-code M16 |
|---|---|---|
| Base 目录 | `~/.claude/projects/<key>/memory/` | `~/.nova-code/memory/projects/<key>/`（对齐 nova `~/.nova-code/` 风格） |
| 团队记忆 | `TEAMMEM` feature + `team/` 子目录 + 同步 | 不做 |
| KAIROS daily log | 长会话场景含 | 不做 |
| Forked-agent 实现 | `runForkedAgent` + `cacheSafeParams`（perfect fork，cache prefix 共享） | 复用 M11 `runSubAgent` 派生模式（父消息文本化注入） |
| Selector model | `getDefaultSonnetModel()` | `config.model`（M17 多 provider 后再分层） |
| 输出格式约束 | `output_format: json_schema`（OpenAI 风格） | Anthropic Messages + 文本 JSON parse + 容错 |
| GrowthBook flags | 多个开关 | 单一 `autoMemoryEnabled` |
| Telemetry | 完整 `tengu_memdir_*` 事件 | 同名复用（payload 字段子集） |

---

## 9. 测试覆盖

| 测试 | 覆盖点 |
|---|---|
| `src/services/memory/paths.test.ts` | git root resolution、sanitize、isAutoMemPath、env override、`..` 越狱拒绝 |
| `src/services/memory/scan.test.ts` | 递归扫、frontmatter parse、mtime 倒序、200 cap、剔除 MEMORY.md |
| `src/services/memory/frontmatter.test.ts` | 基本格式、缺失 frontmatter、无效行、中文 |
| `src/services/memory/entrypoint.test.ts` | 200 行截断、25KB 截断、双门 warning 文案 |
| `src/services/memory/prompt.test.ts` | 含 4 type、含 MEMORY.md、空 MEMORY.md 降级文案 |
| `src/services/memory/relevance.test.ts` | mock client：5 个 / 0 个 / 非法 filename 过滤 / abort 不抛 |
| `src/services/memory/extractor.test.ts` | hasMemoryWritesSince 跳过、tool 白名单、写到 memoryDir 外被拒 |
| `src/services/memory/memoryRuntime.test.ts` | static instructions 拼装、surface 去重 |
| `src/QueryEngine.test.ts`（追加）| memoryRuntime 注入后 system prompt 含指令；FileWrite carve-out 跳审批 |
| `src/services/permissions/permissionEngine.test.ts`（追加）| memory carve-out 在各种 mode 下的行为 |
| `src/m16-e2e-memory.test.ts` | 子进程：写记忆 → 重启 → MEMORY.md 加载；per-turn relevance 召回；extractor 兜底 |
| 全量 `bun test` | M0-M15 回归 |

---

## 10. 后续预留

- M17 多 provider 后，可把 selector model 改为更便宜的 Haiku 等价物，并按 provider 分层
- M18 TUI 可加 `/memory` 命令面板：列出当前记忆、人工编辑、删除
- M19 Resume 时可把 surfaced 记忆 path 集合作为 session meta 持久化
- Phase 3 的"长期项目记忆 + 向量检索"可在 M16 文件层之上叠加，不需要重写 Markdown 存储
- 团队记忆（team subdirectory + 同步）作为 M16.5 或独立 milestone 追加

---

## 11. 交叉引用

- [M16 使用手册](../manual/M16-usage-guide.md)
- [M16 架构文档](../architecture/M16-architecture.md)
- [Roadmap](../roadmap.md)
- [M11 AgentTool 设计](./M11-agent-tool.md)（extractor 复用其 sub-agent 模式）
- [M12 Rules 设计](./M12-rules.md)（`MemoryRuntime` 接口形状参考 `ProjectInstructionsRuntime`）
- [M3 权限设计](./M3-permissions.md)（carve-out 改 `permissionEngine` 七步流水线）
