# 01 · Overview —— M3 全局鸟瞰

> 先读本篇得到 M3 权限子系统的全景，再按需要跳读其它五篇。已熟悉 M2 的读者可直接看 §2 起的"增量"部分。

## 1. 一张图看懂权限层

```
┌──────────────────────────────────────────────────────────────────────┐
│                  bin/nova-code.ts → src/cli.ts                       │
│        findCommand("chat" | "ask")  + --dangerously-skip-permissions │
└──────────────┬───────────────────────────────┬───────────────────────┘
               │                               │
   chat 路径   ↓                               ↓   ask 路径
┌───────────────────────────┐    ┌──────────────────────────────────────┐
│ ChatCommand.ts            │    │ AskCommand/runAskWithLLM.ts          │
│  PermissionStore.load(cwd)│    │  PermissionStore.load(cwd)           │
│  permissionMode =         │    │  createHeadlessPermissionProvider()  │
│   default | bypass        │    │  permissionMode =                    │
│  → runChatRepl(...)       │    │   acceptEdits | bypass               │
└──────────┬────────────────┘    │  → runAgentLoop(...)                 │
           │                      └──────────────┬───────────────────────┘
           ↓                                     │
┌───────────────────────────────────────────┐    │
│ runChatRepl.ts                            │    │
│  createReplPermissionProvider(io,readLine)│    │
│  PermissionModeRef = { get, set }         │    │
│   ↑ /permissions mode <m> 在线切换         │    │
│  → session.sendTurn(..., {                │    │
│       permissionMode, permissionStore,    │    │
│       permissionProvider, cwd })          │    │
└──────────┬────────────────────────────────┘    │
           ↓                                     ↓
┌──────────────────────────────────────────────────────────────────────┐
│                       src/QueryEngine.ts                             │
│   runAgentLoop  →  executeToolsAndYieldEvents                        │
│                                                                      │
│   ── Phase A：串行权限判定 ──                                       │
│      for use of toolUses:                                            │
│        evaluatePermission(mode, tool, input, store.getMergedRules)   │
│        decision = "allow" | "deny" | "ask"                           │
│        if "ask": yield permission_request                            │
│                  await provider.requestPermission()                  │
│                  → decisionFromUserChoice → optional addRule         │
│        yield permission_decision                                     │
│                                                                      │
│   ── Phase B：对 allow 项 Promise.allSettled(execute) ──             │
│   ── Phase C：按原序组装 ToolResultBlock[] + tool_result event ──    │
└──────────────────────────────────────────────────────────────────────┘
                              ↑ 纯函数 evaluatePermission
                              │
              ┌───────────────┴───────────────┐
              │  src/services/permissions/    │
              │  ─────────────────────────    │
              │  permissionEngine.ts          │  七步流水线
              │  permissionStore.ts           │  三层规则 + JSON 持久化
              │  PermissionProvider.ts        │  ask 询问接口 + 5 档映射
              │  PermissionMode.ts            │  4 档 + 校验
              │  PermissionRule.ts            │  规则结构校验 + key
              │  bashRuleMatcher.ts           │  Bash 命令匹配
              │  fileRuleMatcher.ts           │  glob 路径匹配
              │  dangerousPatterns.ts         │  9 条 DENY_PATTERNS
              └───────────────────────────────┘
```

## 2. src/ 目录增量（相对 M2）

```
src/
├── types/
│   └── permissions.ts                ★ 新增
│       PermissionMode  PermissionBehavior  PermissionRule
│       PermissionRuleSource  PermissionRuleWithSource
│       PermissionDecision  UserChoice
│
├── services/
│   └── permissions/                  ★ 新增子目录
│       ├── PermissionMode.ts             4 档常量 + isPermissionMode 守卫
│       ├── PermissionRule.ts             validate/normalize/permissionRuleKey
│       ├── PermissionProvider.ts         接口 + decisionFromUserChoice 映射
│       ├── permissionEngine.ts           evaluatePermission 七步流水线（纯函数）
│       ├── permissionStore.ts            三层规则 + load/addRule/removeRule + JSON
│       ├── dangerousPatterns.ts          DENY_PATTERNS + checkDenyPatterns
│       ├── bashRuleMatcher.ts            "git" / "git:*" / "git status" 语义
│       ├── fileRuleMatcher.ts            glob 子集（* ** ? [abc]）
│       └── index.ts                      barrel：对外只暴露稳定 API
│
├── QueryEngine.ts                    ★ 改造
│   AgentLoopParams 增加 4 字段（permissionMode / permissionStore /
│     permissionProvider / cwd），全部可选 → 不传时回退 M1/M2 行为
│   executeToolsAndYieldEvents 重写为 Phase A/B/C 三阶段
│   buildPersistedRule：Bash → "<cmd>:*"，FileWrite/FileEdit → 原 path
│
├── types/message.ts                  ★ 增 2 个 AgentEvent
│   permission_request   { toolUseId, toolName, input, reason }
│   permission_decision  { toolUseId, toolName, decision, reason, persisted? }
│
├── commands/AskCommand/
│   ├── parseAskFlags.ts              ★ 增 --dangerously-skip-permissions
│   ├── headlessPermissionProvider.ts ★ 新增：一律 deny + stderr 审计
│   └── runAskWithLLM.ts              注入 store + headless provider，
│                                       默认 mode = "acceptEdits"
│
└── commands/ChatCommand/
    ├── ChatCommand.ts                ★ 增 --dangerously-skip-permissions flag
    │                                   PermissionStore.load(cwd) → runChatRepl
    ├── runChatRepl.ts                ★ 创建 replProvider + PermissionModeRef
    ├── replPermissionProvider.ts     ★ 新增：5 档 stderr 菜单 + 安全从严
    ├── renderAgentEvent.ts           ★ 增 permission_request/decision 渲染
    └── slash/
        ├── permissions.ts            ★ 新增：/permissions list / mode [<m>]
        └── types.ts                  ★ 增 PermissionModeRef + ctx 字段
```

## 3. 领域类型一表速查

| 类型 | 取值 | 出处 | 一句话 |
|---|---|---|---|
| `PermissionMode` | `default` / `acceptEdits` / `bypassPermissions` / `plan` | `types/permissions.ts` | 控制 engine 第 2、5 步行为；`plan` 当前占位未实装 |
| `PermissionBehavior` | `allow` / `deny` / `ask` | 同上 | 单条规则的"行为"字段 |
| `PermissionRule` | `{ toolName, ruleContent?, behavior }` | 同上 | 三元组；`ruleContent` 缺省 = 匹配该工具所有调用 |
| `PermissionRuleSource` | `session` / `project` / `global` | 同上 | allow 规则按 `session > project > global` 取优先；deny 不分层 |
| `PermissionRuleWithSource` | `{ rule, source }` | 同上 | engine/store 合并后的统一携带形态 |
| `PermissionDecision` | `allow` / `deny` / `ask` | 同上 | engine 输出；`ask` 需 provider 二次确认 |
| `UserChoice` | `allow-once` / `allow-always-{session,project,global}` / `deny` | 同上 | provider 返回；不设 `deny-always`（避免手滑误升级） |

## 4. 一次 `tool_use` 穿越权限层的完整时序

下例：用户在 `chat` 默认模式下要求 LLM 执行 `git status -s`。

```
LLM 返回 assistant_message
   └─ tool_use { id:"tu_1", name:"Bash", input:{command:"git status -s"} }

QueryEngine.runAgentLoop
   └─ executeToolsAndYieldEvents([tu_1])
        │
        ├─ yield tool_call { tu_1, Bash, input }   ── UI 先看到本轮工具
        │
        └─ Phase A：evaluatePermission({
              mode: "default", tool: "Bash", requiresApproval: true,
              input: {command:"git status -s"},
              rules: [...session, ...project, ...global], cwd })
           │
           ├─ Step 1 DENY_PATTERNS：未命中
           ├─ Step 2 bypass：mode=default，跳过
           ├─ Step 3 deny：无 deny 规则
           ├─ Step 4 allow/ask：无 allow 规则
           ├─ Step 5 acceptEdits：mode≠acceptEdits，跳过
           ├─ Step 6 requiresApproval：BashTool 声明 true → decision=ask
           └─ → yield permission_request { tu_1, Bash, input, reason }

           ChatCommand 的 replPermissionProvider 接管：
              stderr 打印 [permission] Bash `git status -s` — tool requires approval
              + 5 选项菜单
              await readLine()  → 用户选 "2" (allow-always-session)
              → "allow-always-session"

           QueryEngine 收 choice：
              decisionFromUserChoice("allow-always-session")
                 → { decision:"allow", persistTo:"session" }
              buildPersistedRule("Bash", input)
                 → { toolName:"Bash", ruleContent:"git:*", behavior:"allow" }
              await store.addRule("session", rule)   ── 内存追加，不写盘

           yield permission_decision {
              tu_1, Bash, decision:"allow", reason:"user chose allow-always-session",
              persisted:"session" }
              ── renderAgentEvent 打印
                 [permission] allowed & saved to session: Bash

        ├─ Phase B：Promise.allSettled([executeOneTool(tu_1)])
        │            → BashTool.execute → "M  src/QueryEngine.ts\n..."
        │
        └─ Phase C：按 decisions[i] 顺序产出 ToolResultBlock[]
                   + yield tool_result { tu_1, Bash, content, isError:false }

   下一轮 LLM 拿到 tool_result 继续推理。
   后续同 session 内若 LLM 再调 `git log`，engine Step 4 命中 session
   allow rule "Bash git:*"，直接 decision=allow，不再询问用户。
```

时序里几个值得画下重点的关节：

1. **顺序固定**：Step 1 → 7 是不可调换的；任何把 DENY_PATTERNS 放到 bypass 之后的"优化"都会立即破坏深度防御。
2. **provider 不入 engine**：engine 拿到 `decision === "ask"` 直接返回，调用 provider 是 QueryEngine 的责任。这让 engine 在测试里能完全脱离 IO 跑过所有分支。
3. **持久化在拿到用户回应之后才发生**：`decisionFromUserChoice` 决定了"要不要 addRule"以及"写到哪一层"——对 `allow-once` 的回应永远不会污染规则文件。
4. **session 写入是同步内存操作；project/global 写入会触发 fs.writeFile**：所以一旦用户选 `allow-always-project/global`，下一次 `permission_decision` event 的 yield 之间会有一次 await fs IO。

## 5. 关键依赖与约束

- **不依赖 zod**：所有 JSON 校验（permissions.json）走手写 validator，与 `config/config.ts` 的风格一致，避免新增运行时依赖。
- **不依赖 Bun.Glob**：`fileRuleMatcher` 自己把 glob 编译为 RegExp。理由是 `Bun.Glob.match` 行为受 dot/absolute 选项影响，跨版本不稳，单测难以可预测。
- **DENY_PATTERNS 与 BashTool 内部 `HARD_BANNED_PATTERNS` 双写双拦**：信息源同步但代码独立部署，参考 [`docs/design/M3-permissions.md`](../../design/M3-permissions.md) §一深度防御原则。
- **PermissionProvider 是 Promise 接口**：可以阻塞 Phase A 任意长时间等待用户输入。Phase B 才并行；这就是"串行 ask、并行 execute"的语义出处。
- **PermissionStore 是有状态对象**：`session` 规则随进程消亡，`project/global` 通过 `addRule/removeRule` 立即写盘——本设计不引入"批量保存/事务"，每次变更都立即落地，避免崩溃丢规则。

## 6. 阅读顺序建议

> 推荐顺序：本篇 → engine → store → provider → query-engine-phases → chat-ask-integration

- 想搞懂"为什么这次 deny 了" → 直接跳 [permission-engine.md](./permission-engine.md) 看七步流水线 + DENY_PATTERNS 列表。
- 想搞懂"规则文件长啥样、放哪、谁能改" → 直接跳 [permission-store.md](./permission-store.md)。
- 想搞懂"REPL 弹的菜单 5 档怎么选、headless 为什么一律拒" → 跳 [permission-provider.md](./permission-provider.md)。
- 想搞懂"多个 tool_use 并行执行的顺序、deny 后是否还跑别的" → 跳 [query-engine-phases.md](./query-engine-phases.md)。
- 想搞懂"`/permissions` 命令、`--dangerously-skip-permissions` 两个入口的差异" → 跳 [chat-ask-integration.md](./chat-ask-integration.md)。

---

下一篇：[02 · permission-engine.md](./permission-engine.md)
