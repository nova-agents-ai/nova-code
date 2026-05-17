# nova-code 路线图 v2.13

> 渐进对齐 → 改进 → 超越
>
> 最后更新：2026-05-17

---

## 〇、产品定位

nova-code 的使命：

**渐进式实现 claude-code 的全部能力 → 修复 claude-code 已知问题 → 在关键维度超越，成为更强的 Coding Agent**。

这不是 6 周的小项目，而是 **18-24 个月的长期工程**。所有决策围绕三件事：

1. **能力对齐**：claude-code 有的，最终都要有
2. **质量超越**：用更好的架构、更高的代码质量、更可控的行为，做出"同样功能但更好用"的版本
3. **差异化突破**：找到 claude-code 因历史包袱做不到的事，作为护城河

---

## 一、对照基线（快照日期：2026-05-01）

> claude-code 持续在更新，下表数据为 2026-05-01 当日仓库快照；后续版本若需重新对齐，请更新此表与日期。

| 维度 | claude-code | nova-code 现状 | 差距 |
|---|---|---|---|
| 文件数 | 1,902 | 18 | ~106× |
| 代码行数 | ~512,000 | 3,172 | ~162× |
| 顶层目录 | 36 | 平铺 | — |
| 工具数 | 38 | 2（list_dir, read_file） | — |
| 子命令 | 87 | 3（hello, ask, chat） | — |
| UI 组件 | 389（React + Ink） | 0 | — |
| 服务模块 | 130 | 0 | — |

claude-code 关键模块全景：`tools/`(184 文件) `commands/`(207, 87 子命令) `components/`(389 React) `ink/`(96) `utils/`(564) `services/`(130, 含 mcp/api/compact/cost) `hooks/`(104)，以及 `bridge/` `buddy/` `remote/` `skills/` `vim/` `voice/` `plugins/` `migrations/`。

---

## 二、三大阶段总览

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: CATCH-UP (追赶期)        7 个 milestone → 能用版       │
│  目标：核心 agent + 主力工具集 + 基础交互，覆盖 80% 日常任务      │
├─────────────────────────────────────────────────────────────────┤
│  Phase 2: PARITY  (平齐期)         8 个 milestone → 对齐版       │
│  目标：MCP/Skills/Hooks/多 provider/TUI，功能上 ≈ claude-code    │
├─────────────────────────────────────────────────────────────────┤
│  Phase 3: BEYOND  (超越期)          持续        → 领先版          │
│  目标：修复 claude-code 已知缺陷 + 注入 nova 独有能力             │
└─────────────────────────────────────────────────────────────────┘
```

> **节奏说明**：本路线图**以 milestone 完成度而非时间为节奏**。不预设月数承诺，每个阶段以下方"退出标准"判定收官。阶段以"主轴推进 + 少量并行"运行，允许末期启动下一阶段调研。

---

## 三、Phase 1 — Catch-up（追赶期）

**阶段目标**：做完后能脱离 claude-code 自用，覆盖"读代码 / 改代码 / 跑命令 / 多轮对话 / 长会话稳定"五大场景。

### M0 — 基线 ✅（已完成）

单 shot ask + 2 只读工具 + Anthropic 流式 + mock + debug。

**M0 已知技术债**（必须在后续 milestone 内偿还）：

- `commands.ts` 已 200+ 行混合多职责 → M1.5 拆
- `Tool` 接口缺 `abortSignal` 参数 → M1 引入 bash 时必补
- `runAgentLoop` 无 retry / rate limit → M1.5 内必加
- debug sink 是单文件累加 → M2 多 session 时按 session 切分
- 无 e2e 测试，仅 mock 单测 → M1.5 前补一组真实流程的 e2e

### M1 — 工具系统补齐（核心写权工具）

**新增工具**：`BashTool` / `FileWriteTool` / `FileEditTool` / `GrepTool` / `GlobTool`

**结构对齐**（按 §7.0 全局原则）：

- 把 `src/llm/types.ts` 中的 `Tool` 接口搬到 `src/Tool.ts`（顶层）
- 把 `src/llm/tools.ts` 拆为 `src/tools.ts`（注册表）+ `src/tools/<ToolName>/<ToolName>.ts`（每工具一目录）
- 已有的 `list_dir` / `read_file` 同步重命名为 `LSTool` / `FileReadTool` 并迁移到对应目录
- 共享 helper 放 `src/tools/shared/`（目录），常量放 `src/tools/utils.ts` 或 `src/tools/shared/limits.ts`
- 完成后 `src/llm/tools.ts` 与 `src/llm/types.ts` 删除（不留 re-export shim）

**配套**：`Tool` 加 `abortSignal` + `requiresApproval` 字段

**参照**：`claude-code/src/tools/{BashTool,FileWriteTool,FileEditTool,GrepTool,GlobTool}/`

**与 claude-code 的差异声明**：

- nova-code 保留 `LSTool`（claude-code 无此工具，是 M0 的小幅扩展）
- 工具数量子集（M1 仅 7 个工具，claude-code 有 ~38 个）

**失败信号**：bash 工具被滥用导致系统污染 → 回退到默认 dry-run 模式

**DoD**：能完成"批量改文件名 + 改对应 import"这类任务

### M1.5 — 重构窗口 #1

**偿还 M0 + M1 的技术债 + 进一步对齐 claude-code 结构**：

- 拆 `commands.ts` → `src/commands/<CommandName>/<CommandName>.ts`（对齐 claude-code 的 `src/commands/` 结构 + 偿还 M0 债 #1）
- 把 `src/llm/query.ts` 重命名 + 搬迁到 `src/QueryEngine.ts`（对齐 §7.0 + 偿还 M0 命名空间债）
- 抽 `src/services/api/` 层（对齐 claude-code），**实现** retry / rate limit / abort 完整能力（偿还 M0 债 #3，参照 `claude-code/src/services/api/`）
- debug sink 改为按 session 切分文件（偿还 M0 债 #4，为 M2 多轮会话预备）
- 补一组 e2e 测试（mock server + 真 stdin/stdout）（偿还 M0 债 #5）
- 完成后 `src/llm/` 命名空间应已清空并删除

> 不留这个窗口，M2-M6 会在 M0 的脆弱地基上越叠越歪。

### M2 — 多轮 REPL（chat 子命令）

**新增**：`nova-code chat`、`Conversation` 类、斜杠命令骨架（`/clear` `/exit` `/save` `/load`）

**约束**：暂不引入 React/Ink，用 Node `readline` + `picocolors`

**参照**：`claude-code/src/replLauncher.tsx`（仅看交互逻辑，不抄 UI）

**DoD**：chat 模式连续 10 轮对话不丢上下文，Ctrl+C 二级中断

### M3 — 权限与安全 ✅（已完成）

**新增**：调用前询问 / allowlist 持久化 / `--dangerously-skip-permissions`

**参照**：`claude-code/src/utils/permissions/`、`hooks/toolPermission/`

**失败信号**：每次都被询问烦到必须开 skip-permissions → 回退到 allowlist + 危险命令黑名单

**DoD**：默认运行下，bash/write/edit 调用前必有用户确认

**交付摘要**：
- 类型骨架 `src/types/permissions.ts`（PermissionMode 四档 / PermissionBehavior / PermissionRule / UserChoice）
- 七步流水线 `src/services/permissions/permissionEngine.ts`（DENY_PATTERNS → bypass → deny → allow/ask → acceptEdits → requiresApproval → 默认 allow）
- 三层规则存储 `PermissionStore`（session > project > global，`<cwd>/.nova-code/permissions.json` + `~/.nova-code/permissions.json`）
- `PermissionProvider` 接口 + REPL 版 5 档交互弹窗（`replPermissionProvider.ts`）+ ask 版 headless auto-deny（`headlessPermissionProvider.ts`）
- QueryEngine 改造为 Phase A 串行权限判定 + Phase B 并行 execute + Phase C 按序组装，并扩展 `permission_request` / `permission_decision` 事件
- `/permissions` 斜杠命令（list / mode）+ `--dangerously-skip-permissions` flag（chat/ask 均支持）
- 详见 `docs/design/M3-permissions.md`；使用手册 `docs/manual/M3-usage-guide.md`；实现架构 `docs/architecture/M3/README.md`

### M4 — 上下文压缩 ✅（已完成）

**新增**：自动 compact 触发器 + `/compact` 手动命令 + system prompt 注入 CLAUDE.md

**参照**：`claude-code/src/services/compact/`

**失败信号**：compact 后模型严重遗忘 → 回退到"保留最近 5 轮原文 + 仅压缩更早历史"（已落地 `partialCompactConversation`，配置切换待自用反馈触发）

**DoD**：50 轮对话不触发 token 超限 ✅

**交付摘要**：
- `src/services/compact/` 7 文件（contextWindow / tokens / prompt / compact 主路径 / partialCompact 回退 / autoCompact 触发器 + circuit breaker / index）
- `src/services/projectInstructions/` 3 文件（pathDiscovery / claudeMd 含 4 层 + @include / index）
- QueryEngine 集成：每轮 turn 之前 `tryAutoCompact` + system prompt 拼接 projectInstructions；锚点更新；3 个新可选字段全部向后兼容
- ChatSession 新增 `compact()` 方法（快照+成功才提交的原子语义）
- `/compact` 斜杠命令（支持自定义指令）+ SlashContext 增加 chatRuntime 字段
- AgentEvent 新增 `compact_start` / `compact_end` 两类；renderAgentEvent + runAskWithLLM 同步渲染
- mockClient 扩展：按 prompt 特征检测 compact 请求（请求仍带主循环同款 tools + `tool_choice:none`）+ NOVA_MOCK_INFLATE_USAGE 触发阈值 + system 字段落盘
- 测试：约 105 条新单测 + 4 条 e2e（自动 / /compact / 50 轮 / CLAUDE.md @include）；M4 完成时全绿
- 详见 `docs/design/M4-compact.md`、使用手册 `docs/manual/M4-usage-guide.md`、实现架构 `docs/architecture/M4/README.md`

### M5 — Cost、Config CLI、init ✅（已完成）

**新增**：`nova-code cost` / `config get|set` / `init`（生成 CLAUDE.md）

**参照**：`claude-code/src/cost-tracker.ts` + `commands/{cost,config,init}/`

**DoD**：chat 结束打印 token 消耗与估算费用 ✅

**交付摘要**：
- `src/services/cost/` 4 文件（pricing 静态价格表 / CostTracker 累计器 / cost ledger JSONL / index）
- chat 退出时打印 `[cost] Total cost` / usage by model，并 best-effort 追加 `~/.nova-code/cost.jsonl`
- 普通 turn、自动 compact、手动 `/compact` 三类 LLM 调用都进入同一份 `CostTracker`
- `nova-code cost [--json]` 汇总历史 chat ledger；空 ledger 安全显示 0 usage
- `nova-code config get|set` 读写 `~/.nova-code/config.json`，支持 apiKey/baseURL/model/maxTokens/maxTurns；apiKey 输出脱敏
- `nova-code init [--force]` 生成最小 `CLAUDE.md` 模板，默认拒绝覆盖
- AgentEvent `compact_end` 新增可选 `usage?: ApiUsage`，向后兼容旧消费者
- 测试：新增 cost/config/init 单测 + `m5-e2e-cost`；全量 616 tests 通过
- 详见 `docs/design/M5-cost-config-init.md`、使用手册 `docs/manual/M5-usage-guide.md`、实现架构 `docs/architecture/M5-architecture.md`

### M6 — TodoWrite 工具 ✅（已完成）

**新增**：内存任务表 + ASCII 渲染 + system prompt 引导

**参照**：`claude-code/src/tools/TodoWriteTool/`

**DoD**：模型在跨多文件任务时主动调用 ✅

**交付摘要**：
- 新增 `src/tools/TodoWriteTool/`（constants / prompt / todoTypes / todoState / renderTodoList / Tool 实现），工具名与输入 shape 对齐 claude-code：`TodoWrite({ todos })`，`content` / `status` / `activeForm` 三字段同形
- `src/tools.ts` 注册第 8 个内置工具；`requiresApproval=false`，不走写权审批
- `buildSystemPrompt({ toolNames })` 在 TodoWrite 可用且未显式传入 systemPrompt 时追加 TodoWrite guidance；chat 手动 `/compact` runtime 复用同一构造路径，避免 prompt cache 漂移
- `todoState` 采用 M6 范围内的进程级内存表；完整 list 替换状态，全部 `completed` 后清空存储
- `renderTodoList` 输出 `[x]` / `[*]` / `[ ]` 三态 ASCII；ask/chat 对 TodoWrite 成功 tool_result 例外展示到 stderr
- mock transport 新增 `NOVA_MOCK_SCENARIO=todo-loop`，验证复杂任务开头主动 TodoWrite
- 测试：新增 TodoWrite 单测、QueryEngine prompt 注入测试、integration TodoWrite、`m6-e2e-todowrite`；全量 631 tests 通过
- 详见 `docs/design/M6-todowrite.md`、使用手册 `docs/manual/M6-usage-guide.md`、实现架构 `docs/architecture/M6-architecture.md`

### M6.5 — 重构窗口 #2 + Phase 1 收官 ✅（已完成）

- 完整 e2e 套件覆盖 M1-M6 主路径 ✅
- 性能 baseline（启动时间 / 单工具调用延迟）✅
- **sessionId 对齐**：`generateSessionId` 统一切换为 `randomUUID()`（UUID v4），对齐 claude-code（§7.0）。历史 `<YYYY-MM-DDTHH-mm-ss>-<hex8>` 会话文件可继续 `/load` / `--resume`。✅
- 发布准备：Phase 1 已具备 Daily Driver 自用入口；实际 git tag / release 由独立发布流程执行。

**交付摘要**：
- `src/commands/ChatCommand/sessionId.ts` 改用 `crypto.randomUUID()`，并新增 UUID v4 校验 helper；`sessionId.test.ts` 改为 UUID v4 断言
- `sessionStore` 保持宽松读取，新增 legacy timestamp sessionId 往返测试，确保旧会话文件可并存
- `m2-e2e-chat` 断言 `/save` 主文件名为 UUID v4；`docs/manual/M2-usage-guide.md` 示例同步为 UUID v4
- 新增 `src/m6-5-e2e-phase1.test.ts`，覆盖 M3 ask 默认权限与 `--dangerously-skip-permissions` 真实子进程路径
- 新增 `src/services/performance/perfBaseline.ts` 与 `bun run perf:baseline`，记录启动耗时和 mock 单工具闭环耗时；baseline 见 `docs/performance/M6.5-baseline.md`
- 详见 `docs/design/M6.5-phase1-stabilization.md`、使用手册 `docs/manual/M6.5-usage-guide.md`、实现架构 `docs/architecture/M6.5-architecture.md`

**Phase 1 退出标准**：自用 1 个月，记录所有"想要但没有"的 claude-code 功能 → 作为 Phase 2 的优先级输入。

---

## 四、Phase 2 — Parity（平齐期）

**阶段目标**：把 claude-code 中"非核心但生态价值高"的部分都补上，达到功能对齐。

每个 milestone 比 Phase 1 大，每期约 4-8 周。

### M7 — Web 工具组 ✅（已完成）

WebFetchTool / WebSearchTool / 网页正文抽取。
**参照**：`claude-code/src/tools/{WebFetch,WebSearch}/`

- 新增 `src/tools/WebFetchTool/`：公共 HTTP(S) fetch、HTML/text/JSON/XML 正文抽取、15s timeout、1MB bytes cap、50K chars cap
- 新增 `src/tools/WebSearchTool/`：HTML search endpoint 检索、DuckDuckGo `uddg` 结果解析、`allowed_domains` / `blocked_domains` 过滤
- Web 工具共享 `fetchWebContent()`，默认拒绝 localhost / 私网 / link-local host；本地测试需显式 `NOVA_WEB_ALLOW_PRIVATE_HOSTS=1`
- mock transport 新增 `NOVA_MOCK_SCENARIO=web-loop`，覆盖 `WebFetch → WebSearch → end_turn` 主循环
- M7.1 增加 Web proxy routing：`webProxy` / `webProxyDomains` 可配置，`NOVA_WEB_PROXY` / `NOVA_WEB_PROXY_DOMAINS` 可环境覆盖，LLM 可通过 `use_proxy=true` 显式请求代理；代理凭证不会出现在 tool_result 中
- 详见 `docs/design/M7-web-tools.md`、使用手册 `docs/manual/M7-usage-guide.md`、实现架构 `docs/architecture/M7-architecture.md`

### M8 — MCP 客户端协议 ✅（已完成）

**Phase 2 的重头戏**。实现 MCP server 接入，让 nova-code 自动获得整个 MCP 生态的工具。

**参照**：`claude-code/src/services/mcp/`

**风险**：MCP 协议本身在演进，需做好版本兼容

**DoD**：能接入 3 个公开 MCP server（filesystem / git / brave-search）✅（提供 stdio 配置模板；本地自动化用 fixture 验证协议链路）

**交付摘要**：
- 新增 `src/services/mcp/`：`McpStdioClient` 手写最小 JSON-RPC stdio client，支持 `initialize` / `notifications/initialized` / `tools/list` / `tools/call`
- `mcpServers` 写入 `~/.nova-code/config.json`，支持 `command` / `args` / `env` / `cwd` / `timeoutMs` / `disabled` / `autoApprove`；server name 受限为 `[A-Za-z0-9_-]+`
- MCP 工具通过 `MCP__<server>__<tool>` 命名空间 bridge 成 nova `Tool`，默认 `requiresApproval=true`，只有 `autoApprove=true` 才免审批
- 新增 `nova-code mcp list|add|remove|tools`；`config get` 全量输出会脱敏 MCP env
- ask/chat 启动时动态加载 MCP tools，与 `builtinTools` 合并后进入 QueryEngine；单 server 失败只 warning，不阻断内置工具
- mock transport 新增 `NOVA_MOCK_SCENARIO=mcp-loop`，新增 stdio echo fixture 与 M8 e2e
- M8.1 新增 Streamable HTTP transport：`type: "http"` / `url` / `headers` 配置，`nova-code mcp add-http` 管理 HTTP MCP server
- M8.1 新增 `notifications/tools/list_changed` 读取与 registry 刷新；chat 下一轮会读取最新 MCP 工具列表
- 详见 `docs/design/M8-mcp-client.md`、使用手册 `docs/manual/M8-usage-guide.md`、实现架构 `docs/architecture/M8-architecture.md`；M8.1 详见 `docs/design/M8.1-mcp-http-refresh.md`、`docs/manual/M8.1-usage-guide.md`、`docs/architecture/M8.1-architecture.md`

### M9 — Skills 系统 ✅（已完成）

可装载的领域提示词包，对齐 `~/.agents/skills/` 的形态。

**参照**：`claude-code/src/skills/` + `commands/skill/`

**机会**：后续可在 claude-code 的模型语义选择基础上增加可观测的 skill 调用评测与安装/升级能力。

**交付摘要**：
- 新增 `src/services/skills/`（frontmatter 子集解析 / skill roots 发现 / catalog loader / model-facing listing / Skill tool 与 slash skill body formatter）
- 默认扫描 `<cwd>/.nova-code/skills`、`~/.nova-code/skills`、`~/.agents/skills`；每个 root 只加载直接子目录 `<name>/SKILL.md`；支持 `NOVA_DISABLE_SKILLS=1` 禁用、`NOVA_SKILL_DIRS=/a,/b` 覆盖 roots
- ask/chat 复用 `projectInstructions` 通道只注入 model-invocable skill 名称/描述列表；完整 body 由新增 `Skill` tool 在模型选择后加载，或由用户 `/name args` 显式调用时本地展开
- 新增 `nova-code skill list|show`，用于本地查看 skill 与正文；普通语义匹配交给 LLM + `Skill` tool
- `disable-model-invocation: true` 会把 skill 排除出模型可见 listing 与 `Skill` tool 可调用集合，但仍允许用户 slash 显式调用；`user-invocable: false` 则禁止用户 slash 调用
- 测试：新增 parser/loader/prompt/slash 单测、SkillTool 单测、SkillCommand 单测、`m9-e2e-skills` 子进程 listing/body/slash 展开验证
- 详见 `docs/design/M9-skills.md`、使用手册 `docs/manual/M9-usage-guide.md`、实现架构 `docs/architecture/M9-architecture.md`

### M10 — Hooks 系统 ✅（已完成）

工具调用前后的用户脚本拦截。
**参照**：`claude-code/src/utils/hooks/`

**交付摘要**：
- 新增 `src/services/hooks/`（types / config validator / matcher / Bun.spawn command executor / hook runner）
- `~/.nova-code/config.json` 新增 `hooks` 字段，支持 `PreToolUse` / `PostToolUse` 两个事件、`matcher`、`if` 条件、`timeout` 与 `type:"command"`
- QueryEngine 工具生命周期改为 `tool_call → PreToolUse → permissionEngine → execute tool → PostToolUse → tool_result`
- PreToolUse 支持 `updatedInput` 与阻断；PostToolUse 支持 `updatedOutput`、`additionalContext` 与阻断
- AgentEvent 新增 `hook_result`；debug sink 记录完整 stdout/stderr，ask/chat 普通 UI 只展示阻断 / warning / cancelled
- 测试：新增 hooks 单测、QueryEngine hook 集成测试、renderAgentEvent hook 测试、`m10-e2e-hooks` 子进程验证
- 详见 `docs/design/M10-hooks.md`、使用手册 `docs/manual/M10-usage-guide.md`、实现架构 `docs/architecture/M10-architecture.md`

### M11 — AgentTool（子 agent 派生）

模型可派生子 agent 跑独立子任务，主 agent 只看摘要。

**参照**：`claude-code/src/Task.ts` + `tools/AgentTool/`

**前置**：M2 REPL + M4 compact 都已稳定

### M12 — 多 Provider 抽象

OpenAI / Bedrock / Vertex / 国产模型（DashScope / 智谱 / Moonshot）。

**参照**：`claude-code/src/services/api/` 的多 provider 切换

**机会**：claude-code 偏向 Anthropic 生态，nova 做真正中立的多 provider 是天然差异化

### M13 — TUI（React + Ink）

到这一期再做 TUI 而不是早期做，原因：

- 早期做会被 UI 改动拖慢核心 loop 迭代
- 此时核心已稳定，TUI 是纯增量

**参照**：`claude-code/src/components/` + `ink/`

**减重策略**：claude-code 用了 389 个 React 组件，nova 目标 < 80 个

### M14 — Resume / Save / Share 会话

`commands/resume`、会话持久化到 `~/.nova-code/sessions/`、生成可分享链接（本地导出 markdown）。

**参照**：`claude-code/src/history.ts` + `commands/{resume,share}/`

### M14.5 — 重构窗口 #3 + Phase 2 收官

- 全模块审计：单文件 < 600 行硬约束、循环依赖清零
- 性能回归：与 v0.5.0 baseline 对比，启动时间不退化超 20%
- 发布 **v1.0.0 — Parity Release**：宣布功能上对齐 claude-code 主线

**Phase 2 退出标准**：开放给 10 个外部用户试用 4 周，收集"相比 claude-code，缺什么/差什么"反馈。

---

## 五、Phase 3 — Beyond（超越期）

**阶段目标**：claude-code 因历史/产品决策做不好或做不到的事，nova 做出来。

### 主线 A：修复 claude-code 已知问题

> ⚠️ **下表为撰写时基于公开信息与个人推测整理的初步清单，并非经过 claude-code 团队确认的事实**。**真实优先级由 Phase 1/2 自用过程中维护的 `docs/pain-points.md` 决定**。Phase 3 启动前，本表必须用真实使用记录重写。

| claude-code 已知问题 | nova-code 改进方向 |
|---|---|
| 单文件动辄 1000+ 行（utils/ 564 文件大杂烩） | 严格架构约束 + 模块化 lint 规则 |
| context 自动 compact 后常遗忘关键决策 | 重要决策抽到"长期记忆"区，不参与 compact |
| 工具调用串行，多读文件慢 | 工具调用并行调度 |
| 权限询问粒度粗（一允全允） | 路径级 / 命令级 / 参数模式级精细权限 |
| 跨会话无记忆 | 项目级长期记忆库（向量检索） |
| 单 agent loop，复杂任务易跑偏 | Plan-Execute-Verify 三阶段 loop |
| 错误恢复弱（工具报错就停） | 错误自愈：自动重试 / 自动调整策略 |
| 成本不透明，不知道哪步贵 | 实时成本面板 + 单步成本归因 |

### 主线 B：nova 独有能力（差异化护城河）

候选方向，按下述**评分模板**排序后定优先级：

| 维度 | 1 分 | 3 分 | 5 分 |
|---|---|---|---|
| **个人使用价值** | 几乎用不到 | 偶尔用得上 | 每日使用 |
| **生态/学习价值** | 仅自己受益 | 小众用户受益 | 推动 agent 领域认知 |
| **实现成本** | > 2 个月 | 3-6 周 | < 2 周 |
| **差异化强度** | 已有开源方案 | 仅 claude-code 缺 | 业界首创 |

> 综合分 = (个人价值 + 生态价值 + 差异化强度) × 2 - 实现成本。Phase 3 启动时为下方 10 个候选逐一打分，>20 分的优先做。

候选方向：

1. **本地化模型支持**：vLLM / Ollama / LM Studio 集成，离线可用
2. **多模型协作**：Planner（强模型）+ Executor（弱模型）混合，省成本
3. **长期项目记忆**：跨会话的项目级知识图谱
4. **可观测性**：完整 trace + replay，每次 agent 决策可回放分析
5. **协作模式**：多人共享同一个 agent session（pair programming with AI）
6. **沙箱执行**：所有工具默认在 docker / firecracker 微 VM 内执行
7. **声明式 Agent 编排**：YAML 描述多 agent workflow
8. **Self-improvement**：agent 把成功 pattern 沉淀为新 skill
9. **IDE 插件**（VSCode / JetBrains）：作为 backend，IDE 作为 UI
10. **手机端**（iOS/Android 客户端）：远程触发 agent

Phase 3 不预设具体顺序。

---

## 六、Milestone 依赖图

```
                       M0 ✅
                         │
                         ▼
                    M1 工具补齐
                         │
                         ▼
                   M1.5 重构窗口
                         │
              ┌──────────┼──────────┬──────────┐
              ▼          ▼          ▼          ▼
           M3 权限   M2 REPL    M5 Cost   M6 TodoWrite
                         │       Config
                         ▼
                    M4 Compact
                         │
                         ▼
                  M6.5 重构 #2
                         │
                         ▼
                   ═══ v0.5.0 ═══
                         │
                         ▼
                   Phase 2 (M7-M14)
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         M7/M8/M9    M10/M12     M13 TUI
         (独立)      (独立)      (M2 后)
                         │
                         ▼
                    M11 AgentTool
                    (依赖 M2 + M4)
                         │
                         ▼
                  M14.5 重构 #3
                         │
                         ▼
                   ═══ v1.0.0 ═══
                         │
                         ▼
                  Phase 3 持续迭代
```

- **硬依赖**：
  - M1 → M3（权限保护的是 M1 的写权工具）
  - M2 → M4（compact 服务于多轮对话）
  - M2 → M14（resume 服务于 chat 会话）
  - M2 + M4 → M11（AgentTool 需要稳定的多轮 + compact 基础）
- **软建议**：
  - M3 / M2 / M5 / M6 在 M1.5 之后可任意顺序、可并行
  - Phase 2 内 M7 / M8 / M9 / M10 / M12 / M13 大体独立，可按兴趣排序

---

## 七、贯穿三阶段的工程纪律

### 7.0 与 claude-code 结构对齐（最高优先级原则）

> 本节是 nova-code 的**最高优先级工程原则**，所有后续设计文档与代码实现必须遵守。

**原则**：nova-code 的目录结构、模块划分、类与接口的命名 / 形状，**必须与 claude-code 保持一致**。

**为什么**：

- nova-code 定位是"渐进追赶 → 平齐 → 超越 claude-code"。结构对齐是"渐进追赶"的物理基础 —— 任何从 claude-code 移植的逻辑都能"原位落地"，而不是"先翻译再落地"
- 评审 / 排查时可以直接用 claude-code 的同名文件做对照基线
- Phase 3 "超越期"才能精确定位"我们改了 claude-code 的哪个文件 / 哪个类"

**具体规约**：

| 维度 | claude-code 形态 | nova-code 必须 |
|---|---|---|
| **顶层入口文件** | `src/Tool.ts` / `src/tools.ts` / `src/commands.ts` / `src/QueryEngine.ts` 等放 `src/` 顶层 | 同名同位置（`src/Tool.ts` / `src/tools.ts` / ...） |
| **工具实现** | `src/tools/<ToolName>/<ToolName>.ts`，每工具一个目录，**PascalCase + Tool 后缀** | 同结构同命名风格 |
| **工具命名** | `BashTool` / `FileWriteTool` / `FileEditTool` / `GlobTool` / `GrepTool` / `FileReadTool` 等 | 完全沿用同名 |
| **共享 helper** | `src/tools/shared/`（目录） + `src/tools/utils.ts`（顶层 utils） | 同结构 |
| **子系统目录** | `src/commands/` / `src/components/` / `src/services/` / `src/hooks/` / `src/utils/` 等 | 在引入对应能力时同名建目录 |
| **类型 / 接口形状** | claude-code 的 `Tool` 接口字段、`QueryEngine` 类方法签名 | 字段名、方法签名尽量同形（仅在有充分理由时偏离，且偏离必须在设计稿中显式声明） |

**允许的偏离**（必须在对应设计稿中显式声明并给出理由）：

1. **claude-code 没有但 nova-code 需要**的工具 / 模块：按 claude-code 命名风格新建（如 `LSTool`、`shared/cwd.ts`），并在设计稿"与 claude-code 的差异"段落标注
2. **claude-code 有但 nova-code 暂不实现**的：在路线图标注 milestone 归属，不提前预留空目录
3. **claude-code 已知反模式**（如 `utils/` 564 文件大杂烩、单文件 1000+ 行）：nova-code 在 §7.1 / §7.2 的硬约束下重新组织，但**子目录与文件命名仍尽量对应**（拆分而非改名）

**当前已存在的偏离**（M0 历史包袱，需在 M1 / M1.5 偿还）：

| nova-code 现状 | claude-code 对应 | 偿还时机 |
|---|---|---|
| `src/llm/types.ts` 中定义 `Tool` 接口 | `src/Tool.ts` | M1 同步搬到 `src/Tool.ts` |
| `src/llm/tools.ts` 单文件含所有工具 | `src/tools.ts` 注册表 + `src/tools/<X>/<X>.ts` 子目录 | M1 拆分 |
| `src/llm/query.ts` | `src/QueryEngine.ts`（`src/query.ts` 是另一个文件） | M1.5 重命名（与 retry/transport 抽取一起） |
| `src/llm/` 命名空间整体 | claude-code 无 `llm/` 子命名空间，所有都在 `src/` 顶层 | M1.5 完成后 `src/llm/` 应消失 |
| `src/cli.ts`（自创） | claude-code 是 `src/main.tsx` + `src/cli/` 目录（含子模块） | M1.5 / M2 阶段对齐 |
| `sessionId` 曾用 `<YYYY-MM-DDTHH-mm-ss>-<hex8>` | claude-code 统一 `randomUUID()`（UUID v4） | ✅ M6.5 已切换；历史文件可并存 |

> 这些偏离是 M0 早期没有此原则时的产物。**M1 实施时必须同步修复**，不再扩大。

### 7.1 架构地基（决定能否走到 Phase 3）

- **每文件 < 600 行硬上限**，超出 CI fail（claude-code 的 utils/ 是反面教材）
- **每模块明确职责边界**，禁止 utils 大杂烩
- **核心 loop 与 transport / tools / ui 分层**，每层可独立替换
- **所有外部集成走 adapter 模式**：provider / mcp / skills / hooks 都是插件

### 7.2 质量基线（决定"超越"是否可信）

- 每个 milestone 进入前先写设计文档（`docs/design/MX-*.md`）
- 每个 milestone 必有单测 + e2e + 性能基准
- 每三个 milestone 一次重构窗口（M1.5 / M6.5 / M14.5 是显式预留）
- Biome + tsc strict + e2e 必须全绿才能合并主分支

### 7.3 持续记录（决定 Phase 3 方向）

- 自用过程中维护 `docs/pain-points.md`，记录"用 claude-code 时遇到的问题 + 用 nova 时遇到的问题"
- 每个 release 后做 retro，沉淀到 `docs/retro/`
- Phase 3 的优先级**完全由这两个文档驱动**，不由想象驱动

### 7.4 速率与节奏

- **节奏由完成度驱动，不由时间驱动**：本路线图全文不出现具体月数承诺，避免"按时但不达标"或"超时但已完成 80%"的尴尬
- **退出标准是唯一的阶段判据**：每个 Phase 必须满足其退出标准才算收官，时间长短不论
- 每个 milestone 完成立刻 git tag + release，让"进展可见"
- 每月写一次月度进展（`docs/progress/YYYY-MM.md`），积累成长曲线

---

## 八、立即可做的下一步

按依赖图，**M1（工具补齐）是必经之路**。建议立即启动：

1. 写 `docs/design/M1-tools.md`，明确 5 个新工具的接口、安全策略、超时/截断规则
2. 优先实现 `bash` 工具：它最复杂、最危险，做好它能验证整套设计模式（abortSignal、超时、输出截断、危险命令拦截）
3. 同步埋 M1.5 重构需求：M1 写代码时把"应当抽到 transport 层的"标记 `// REFACTOR M1.5`，不在 M1 内做但记录下来

---

## 九、版本历史

- **v2.14**（2026-05-17）：M10 Hooks 系统落地。新增 `src/services/hooks`，支持 `PreToolUse` / `PostToolUse` command hooks；配置写入 `~/.nova-code/config.json` 的 `hooks` 字段，支持 matcher、轻量 `if` 条件、超时、stdin JSON 协议、exit code 2 阻断、stdout JSON `updatedInput` / `updatedOutput`；QueryEngine 在权限系统前执行 PreToolUse、工具执行后执行 PostToolUse；新增 `hook_result` AgentEvent 与 ask/chat 渲染；新增 M10 设计文档 / 使用手册 / 架构快照；全量 706 tests 通过。
- **v2.13**（2026-05-17）：M9 Skills 系统落地并对齐 claude-code 当前机制。新增 `src/services/skills` 与 `Skill` tool，支持 `~/.agents/skills/<name>/SKILL.md` 直接子目录形态的 frontmatter + body 加载；ask/chat 只注入 skill 名称/描述 listing，完整 body 由模型语义选择后通过 `Skill` tool 加载，或由用户 `/name args` 显式调用时本地展开；`skill` CLI 保留 `list/show`，不再提供本地字符匹配 `match` 子命令；支持 `disable-model-invocation`、`user-invocable`、`NOVA_DISABLE_SKILLS` 与 `NOVA_SKILL_DIRS`；新增 M9 设计文档 / 使用手册 / 架构快照；全量 695 tests 通过。
- **v2.12**（2026-05-16）：M8.1 MCP HTTP/refresh 落地。新增 `McpStreamableHttpClient`，支持 Streamable HTTP `POST` JSON response / `POST` SSE response / 初始化后 `GET` SSE notification；`mcpServers` 支持 `type: "http"`、`url`、`headers` 且 `config get` 对 headers 脱敏；新增 `nova-code mcp add-http`；stdio 与 HTTP client 均可分发 `notifications/tools/list_changed`，registry 会重新 `tools/list` 并刷新 `MCP__server__tool` bridge，chat 下一轮读取最新工具；新增 M8.1 设计文档 / 使用手册 / 架构快照；全量 678 tests 通过。
- **v2.11**（2026-05-15）：M8 MCP 客户端协议落地。新增 `services/mcp` 最小 stdio JSON-RPC client 与 MCP Tool bridge；`PersistedConfig` 新增 `mcpServers`，`nova-code mcp list|add|remove|tools` 管理 server 配置；ask/chat 启动时将 `builtinTools + MCP__server__tool` 动态工具传入 QueryEngine；MCP 工具默认走 M3 权限审批，可信 server 可设 `autoApprove=true`；新增 echo fixture、MCP 单测与 `m8-e2e-mcp`；新增 M8 设计文档 / 使用手册 / 架构快照；全量 673 tests 通过。
- **v2.10**（2026-05-15）：M7.1 Web proxy routing 落地。`PersistedConfig` / `config get|set` 新增 `webProxy` 与 `webProxyDomains`；WebFetch / WebSearch 输入新增 `use_proxy`，允许模型在判断目标站点需要代理时请求使用用户配置的 HTTP(S) proxy；`webProxyConfig.ts` 合并配置文件与环境变量，按域名后缀或 LLM request 决定是否传 Bun `fetch` 的 `proxy` 选项；新增代理路由单测与真实本地 proxy fetch 测试；全量 663 tests 通过。
- **v2.9**（2026-05-14）：M7 Web 工具组落地。新增 `WebFetch` / `WebSearch` 两个内置只读工具，工具注册表扩展到 10 个；`fetchWebContent()` 集中处理 HTTP(S) 校验、private/local host guard、timeout、content-type 与截断；WebFetch 支持轻量 HTML 正文抽取，WebSearch 支持 HTML endpoint、DuckDuckGo `uddg` 解析与域名 allow/block；mock transport 新增 `web-loop` 场景并补本地 HTTP fixture e2e；新增 M7 设计文档 / 使用手册 / 架构快照；全量 653 tests 通过。
- **v2.8**（2026-05-14）：M6.5 Phase 1 稳定化窗口落地。`generateSessionId` 改用 UUID v4 并保留历史 timestamp 会话加载兼容；补齐 M3 权限主路径子进程 e2e，形成 M1-M6 e2e 覆盖矩阵；新增 `perf:baseline` 脚本和 `docs/performance/M6.5-baseline.md`，记录启动与单工具调用延迟；更新 M2 使用手册 sessionId 示例；新增 M6.5 设计文档 / 使用手册 / 架构快照。
- **v2.7**（2026-05-14）：M6 TodoWrite 工具落地。新增 `src/tools/TodoWriteTool/`，对齐 claude-code 的 `TodoWrite({ todos })` 输入 shape 与 `pending/in_progress/completed` 三态；进程内任务表支持完整 list 替换与全部完成后清空；system prompt 在工具可用时追加 TodoWrite guidance；ask/chat 对 TodoWrite 成功结果渲染 ASCII todo list；mock transport 新增 `todo-loop` 场景并补 e2e；新增 M6 设计文档 / 使用手册 / 架构快照；全量 631 tests 通过。
- **v2.6**（2026-05-14）：M5 Cost / Config CLI / init 落地。新增 `src/services/cost`（静态 Anthropic 价格快照、`CostTracker`、`~/.nova-code/cost.jsonl` ledger）；chat 退出打印 `[cost]` 摘要并记录普通 turn + auto compact + manual `/compact` 的 usage；新增 `nova-code cost [--json]`、`nova-code config get|set`（apiKey 脱敏、正整数校验）、`nova-code init [--force]`（最小 CLAUDE.md 模板）；`compact_end` 事件可选携带 `usage?: ApiUsage`；新增 M5 设计文档 / 使用手册 / 架构快照；全量 616 tests 通过。
- **v2.5**（2026-05-12）：M4 上下文压缩 + CLAUDE.md 注入落地。阈值 167K 自动 compact + circuit breaker（失败 3 次停用） + `/compact` 手动 + claude-code 同款 prompt 模板 + token 锚点估算（SDK usage + chars/4）；CLAUDE.md 4 层（managed → user → project chain → local chain）+ `@include` 递归（深度上限 5 + 循环检测）启动时一次注入 system prompt；@include 解析与 HTML comment 剥离用 marked Lexer 复刻 claude-code 同款（支持 inline @path、fragment 剥离、escaped space、TEXT_FILE_EXTENSIONS 白名单）；新增 `services/analytics` 子系统复刻 claude-code 的 `logEvent(name, payload)` 接口（环形 buffer + 可选 JSONL 落盘 + `NOVA_DISABLE_TELEMETRY` / `NOVA_TELEMETRY_FILE` 开关），事件名沿用 `tengu_*` 前缀；新增 `compact_start` / `compact_end` AgentEvent；ChatSession.compact() 用快照+成功才提交避免半提交；partialCompact 同步落地作为 roadmap 失败信号回退方案；约 104 条新单测 + 4 条 e2e；详见 `docs/design/M4-compact.md`、使用手册 `docs/manual/M4-usage-guide.md`、实现架构 `docs/architecture/M4/README.md`
- **v2.4**（2026-05-04）：M3 权限与安全 milestone 落地：七步权限流水线 + 三层规则存储 + 4 档模式 + 5 档交互弹窗；`--dangerously-skip-permissions` / `/permissions` 斜杠命令；ask 默认 acceptEdits + headless auto-deny Provider；chat 默认 default + REPL 5 档 Provider；详见 `docs/design/M3-permissions.md`、使用手册 `docs/manual/M3-usage-guide.md`、实现架构 `docs/architecture/M3/README.md`
- **v2.3**（2026-05-04）：修复 §7.0 表格中 `src/llm/` 应消失的时机表述（M1 → M1.5，与 M1 / M1.5 章节一致）；M1.5 在本版本落地：`src/llm/` 命名空间清空，顺带交付 `QueryEngine.ts` / `services/api/{client,errors,errorUtils,withRetry}` / `errors/` / `types/message.ts` / `commands/<X>Command/`；新增严谨单测的 `withRetry`（429/502/503/504/529 重试 + 网络错误 + Retry-After + AbortSignal）；新增 e2e 用例 m1-5-e2e-writeflow（真子进程 + 内嵌 mock server 覆盖 Grep→FileEdit→Bash 读写闭环）；debug sink 预埋 sessionId 参数为 M2 chat REPL 预留；详见 `docs/design/M1.5-refactor.md`
- **v2.2**（2026-05-01）：新增 §7.0 "与 claude-code 结构对齐（最高优先级原则）"，明确目录 / 模块 / 类命名必须与 claude-code 一致，列出当前 5 处 M0 历史偏离及偿还时机；M1 milestone 重写"新增 / 配套"段落，工具改用 PascalCase + Tool 后缀（BashTool 等），增加"结构对齐"步骤与"与 claude-code 的差异声明"段；M1.5 milestone 加入命名空间清理（`src/llm/` 删除）与 `QueryEngine.ts` 重命名
- **v2.1**（2026-05-01）：修复 v2 内在不一致 — 删除阶段月数估算（与"完成度驱动"原则统一）；M1.5 补全 retry/rate limit 与 debug sink 切分；依赖图重绘（M3 从 M1.5 直接分叉，M11 依赖显式画出）；Phase 3 表格加出处声明；Phase 3 主线 B 补评分模板；基线表加快照日期
- **v2**（2026-05-01）：定位调整为"渐进对齐 → 超越"，分三阶段；新增 M0 已知技术债、3 个重构窗口、失败回退、依赖图、Phase 3 双主线
- **v1**（2026-05-01）：初版，定位"教学复刻"，6 期收工
