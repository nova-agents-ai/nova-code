# nova-code 路线图 v2.4

> 渐进对齐 → 改进 → 超越
>
> 最后更新：2026-05-04

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

### M4 — 上下文压缩

**新增**：自动 compact 触发器 + `/compact` 手动命令 + system prompt 注入 CLAUDE.md

**参照**：`claude-code/src/services/compact/`

**失败信号**：compact 后模型严重遗忘 → 回退到"保留最近 5 轮原文 + 仅压缩更早历史"

**DoD**：50 轮对话不触发 token 超限

### M5 — Cost、Config CLI、init

**新增**：`nova-code cost` / `config get|set` / `init`（生成 CLAUDE.md）

**参照**：`claude-code/src/cost-tracker.ts` + `commands/{cost,config,init}/`

**DoD**：chat 结束打印 token 消耗与估算费用

### M6 — TodoWrite 工具

**新增**：内存任务表 + ASCII 渲染 + system prompt 引导

**参照**：`claude-code/src/tools/TodoWriteTool/`

**DoD**：模型在跨多文件任务时主动调用

### M6.5 — 重构窗口 #2 + Phase 1 收官

- 完整 e2e 套件覆盖 M1-M6 主路径
- 性能 baseline（启动时间 / 单工具调用延迟）
- **sessionId 对齐**：`generateSessionId` 统一切换为 `randomUUID()`（UUID v4），对齐 claude-code（§7.0）。现实现的 `<YYYY-MM-DDTHH-mm-ss>-<hex8>` 是 M2 历史偏离；新旧会话文件可并存（`assertSafeFileName` 只校验路径穿越，UUID v4 合法）。顺带更新 `sessionId.test.ts` 断言与 `docs/manual/M2-usage-guide.md` 示例。
- 发布 **v0.5.0 — Daily Driver**：作者本人完全脱离 claude-code 自用 1 个月

**Phase 1 退出标准**：自用 1 个月，记录所有"想要但没有"的 claude-code 功能 → 作为 Phase 2 的优先级输入。

---

## 四、Phase 2 — Parity（平齐期）

**阶段目标**：把 claude-code 中"非核心但生态价值高"的部分都补上，达到功能对齐。

每个 milestone 比 Phase 1 大，每期约 4-8 周。

### M7 — Web 工具组

WebFetchTool / WebSearchTool / 网页正文抽取。
**参照**：`claude-code/src/tools/{WebFetch,WebSearch}/`

### M8 — MCP 客户端协议

**Phase 2 的重头戏**。实现 MCP server 接入，让 nova-code 自动获得整个 MCP 生态的工具。

**参照**：`claude-code/src/services/mcp/`

**风险**：MCP 协议本身在演进，需做好版本兼容

**DoD**：能接入 3 个公开 MCP server（filesystem / git / brave-search）

### M9 — Skills 系统

可装载的领域提示词包，对齐 `~/.agents/skills/` 的形态。

**参照**：`claude-code/src/skills/` + `commands/skill/`

**机会**：claude-code 的 skill 加载比较粗放，nova 可做**按 query 语义自动激活**（Beyond 期延伸）

### M10 — Hooks 系统

工具调用前后的用户脚本拦截。
**参照**：`claude-code/src/utils/hooks/`

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
| `sessionId` 用 `<YYYY-MM-DDTHH-mm-ss>-<hex8>` | claude-code 统一 `randomUUID()`（UUID v4） | M6.5 切换为 `randomUUID()`（波及面小，历史文件可并存） |

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

- **v2.4**（2026-05-04）：M3 权限与安全 milestone 落地：七步权限流水线 + 三层规则存储 + 4 档模式 + 5 档交互弹窗；`--dangerously-skip-permissions` / `/permissions` 斜杠命令；ask 默认 acceptEdits + headless auto-deny Provider；chat 默认 default + REPL 5 档 Provider；详见 `docs/design/M3-permissions.md`、使用手册 `docs/manual/M3-usage-guide.md`、实现架构 `docs/architecture/M3/README.md`
- **v2.3**（2026-05-04）：修复 §7.0 表格中 `src/llm/` 应消失的时机表述（M1 → M1.5，与 M1 / M1.5 章节一致）；M1.5 在本版本落地：`src/llm/` 命名空间清空，顺带交付 `QueryEngine.ts` / `services/api/{client,errors,errorUtils,withRetry}` / `errors/` / `types/message.ts` / `commands/<X>Command/`；新增严谨单测的 `withRetry`（429/502/503/504/529 重试 + 网络错误 + Retry-After + AbortSignal）；新增 e2e 用例 m1-5-e2e-writeflow（真子进程 + 内嵌 mock server 覆盖 Grep→FileEdit→Bash 读写闭环）；debug sink 预埋 sessionId 参数为 M2 chat REPL 预留；详见 `docs/design/M1.5-refactor.md`
- **v2.2**（2026-05-01）：新增 §7.0 "与 claude-code 结构对齐（最高优先级原则）"，明确目录 / 模块 / 类命名必须与 claude-code 一致，列出当前 5 处 M0 历史偏离及偿还时机；M1 milestone 重写"新增 / 配套"段落，工具改用 PascalCase + Tool 后缀（BashTool 等），增加"结构对齐"步骤与"与 claude-code 的差异声明"段；M1.5 milestone 加入命名空间清理（`src/llm/` 删除）与 `QueryEngine.ts` 重命名
- **v2.1**（2026-05-01）：修复 v2 内在不一致 — 删除阶段月数估算（与"完成度驱动"原则统一）；M1.5 补全 retry/rate limit 与 debug sink 切分；依赖图重绘（M3 从 M1.5 直接分叉，M11 依赖显式画出）；Phase 3 表格加出处声明；Phase 3 主线 B 补评分模板；基线表加快照日期
- **v2**（2026-05-01）：定位调整为"渐进对齐 → 超越"，分三阶段；新增 M0 已知技术债、3 个重构窗口、失败回退、依赖图、Phase 3 双主线
- **v1**（2026-05-01）：初版，定位"教学复刻"，6 期收工
