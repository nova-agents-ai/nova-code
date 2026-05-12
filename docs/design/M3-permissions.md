# M3 — 权限与安全

> 实施日期：2026-05-04
>
> 目标：在默认运行下 `bash / write / edit` 调用前必有用户确认，同时提供可持久化的规则与可显式跳过的逃生舱。

---

## 1. 设计总览

### 1.1 七步决策流水线

对每一次工具调用，依次过以下七个步骤，第一个命中者决定结果：

```
1. DENY_PATTERNS(Bash)      —— 内置高危命令黑名单，任何模式下都拦截
2. bypassPermissions 模式    —— 直接 allow（DENY_PATTERNS 已先拦）
3. 规则 match → deny         —— 显式 deny 规则胜
4. 规则 match → allow/ask    —— 显式 allow / 询问
5. acceptEdits 模式          —— File 写工具直接 allow
6. tool.requiresApproval     —— 工具自身声明需要询问
7. 默认 allow                —— 都没命中即放行
```

流水线第 3、4 步的规则 match 顺序为 `session > project > global`。第 1 步的 DENY_PATTERNS 与第 7 步的默认值是"硬编码底线"，不受规则系统影响。

### 1.2 四档 PermissionMode

| Mode                | 行为                                                          | 适用场景                          |
| ------------------- | ------------------------------------------------------------- | --------------------------------- |
| `default`           | 严格走七步流水线；未知工具调用 → ask                          | chat 默认                         |
| `acceptEdits`       | Phase 5 放行 `FileWrite` / `FileEdit`；Bash 仍走 ask          | ask 默认（生成代码常见场景）      |
| `bypassPermissions` | Phase 2 直接 allow（但 DENY_PATTERNS 仍会拦截）                | `--dangerously-skip-permissions`  |
| `plan`              | 暂与 default 等价，预留 M11 Plan-Execute 模式                  | 未启用                             |

### 1.3 三层规则存储

规则以 `PermissionRule = { toolName, ruleContent?, behavior: allow|deny }` 为单位，分三层：

- `session` —— 进程内存，Ctrl+C 退出即消失
- `project` —— `<cwd>/.nova-code/permissions.json`，受 git 管理的建议值
- `global` —— `~/.nova-code/permissions.json`，跨项目默认

match 顺序 `session > project > global`，最先命中者胜。去重键 = `toolName\truleContent`，同键后写覆盖前写（语义：最新决策胜出）。

规则内容语法（M3 支持的最小集）：

- `Bash` 工具：`ruleContent = "git:*"` 匹配以 `git ` 开头的命令；特殊值 `"*"` 或 `undefined` 匹配任意命令
- `FileWrite` / `FileEdit`：`ruleContent = "/abs/path"` 仅匹配该绝对路径；`"/abs/dir/**"` 暂不支持（M3 非目标）
- 其它工具：`ruleContent = undefined` 匹配该工具的任意调用

### 1.4 五档 UserChoice 与 PermissionProvider

当流水线第 4 步返回 `ask` 时，QueryEngine 调 `PermissionProvider.requestPermission(req)`，返回 `UserChoice`：

| Choice                    | 决策 | 持久化到       |
| ------------------------- | ---- | -------------- |
| `allow-once`              | allow | —              |
| `allow-always-session`    | allow | session         |
| `allow-always-project`    | allow | project         |
| `allow-always-global`     | allow | global          |
| `deny`                    | deny  | —              |

REPL 版 `createReplPermissionProvider` 把 5 档做成交互菜单；headless 版 `createHeadlessPermissionProvider` 永远返回 `deny` 并在 stderr 留一行审计。

---

## 2. 代码组织

```
src/types/permissions.ts                    类型骨架（Mode / Rule / Source / UserChoice）

src/services/permissions/
├── index.ts                                 公共导出
├── PermissionRule.ts                        规则 normalize / validate / 去重键
├── denyPatterns.ts                          DENY_PATTERNS 常量（Bash）
├── bashRuleMatcher.ts                       "命令名:*" 语法匹配
├── fileRuleMatcher.ts                       绝对路径精确匹配
├── permissionEngine.ts                      evaluatePermission 七步流水线
├── permissionStore.ts                       PermissionStore 类 + load/addRule
└── PermissionProvider.ts                    PermissionProvider 接口 + decisionFromUserChoice

src/commands/ChatCommand/
├── replPermissionProvider.ts                REPL 5 档交互菜单
└── slash/permissions.ts                     /permissions 斜杠命令

src/commands/AskCommand/
└── headlessPermissionProvider.ts            headless 一律 auto-deny

src/QueryEngine.ts                           Phase A/B/C 三阶段执行 + 事件流
```

---

## 3. QueryEngine 执行流水线

```
┌────── 旧版（M2）──────┐          ┌────── 新版（M3）──────┐
│ 对每个 tool_use：     │          │ Phase A（串行）       │
│   execute 并行        │          │   每个 tool_use       │
│   yield tool_result   │  ─────▶  │   evaluatePermission  │
└───────────────────────┘          │   provider.requestP() │
                                   │   store.addRule?      │
                                   │   发 permission_* 事件│
                                   ├───────────────────────┤
                                   │ Phase B（并行）       │
                                   │   仅 decision=allow 的│
                                   │   execute             │
                                   ├───────────────────────┤
                                   │ Phase C（按序组装）   │
                                   │   ToolResultBlock[]   │
                                   │   deny 项 is_error    │
                                   └───────────────────────┘
```

**为什么 Phase A 串行**：同一个 assistant 消息里可能有多个 tool_use；若并行询问，终端会出现多个交叉的 5 档菜单，用户无法判断在回答哪个。串行保证"一个问题弹一次，答完再下一个"。

**为什么 Phase B 并行**：一旦 allow，工具自身的 I/O（读文件、跑命令）完全可以并发，沿用 M2 的并行实现。

**为什么 Phase C 按序**：Anthropic API 要求 `tool_result` 的 id 顺序与前面 `tool_use` 一致。

---

## 4. 入口集成

### 4.1 ChatCommand（chat REPL）

```
parseChatFlags → dangerouslySkipPermissions?
                                        │
                                        ▼
ChatCommand.ts:                         │
  PermissionStore.load(cwd)  ◀──────────┘
  mode ← dangerous ? "bypassPermissions" : "default"
                                        │
                                        ▼
runChatRepl:
  permissionModeRef    // 运行时可变，/permissions mode 修改
  permissionProvider ← createReplPermissionProvider({ io, readLine })
  每轮 sendTurn 读 modeRef.current 透传给 runAgentLoop
```

### 4.2 AskCommand（headless）

```
parseAskFlags → dangerouslySkipPermissions?
                                        │
                                        ▼
runAskWithLLM:
  PermissionStore.load(cwd)
  mode ← dangerous ? "bypassPermissions" : "acceptEdits"
  permissionProvider ← createHeadlessPermissionProvider({ stderr })
  runAgentLoop(...)
```

headless 在 `acceptEdits` 下 `FileWrite / FileEdit` 无需询问，适合"echo 生成一段代码"型用例；Bash 仍走 ask → auto-deny，避免管道脚本跑出预期外的 shell 命令。

### 4.3 /permissions 斜杠命令

仅在 chat REPL 中可用：

| 形式                            | 效果                                      |
| ------------------------------- | ----------------------------------------- |
| `/permissions` / `/permissions list` | 分三层打印当前全部规则                    |
| `/permissions mode`             | 显示当前 PermissionMode                   |
| `/permissions mode <m>`         | 切换模式（default/acceptEdits/bypassPermissions/plan） |

增删规则走交互式 5 档菜单，不提供命令行手写语法的入口（第一版避免用户因规则语法错误自伤）。

---

## 5. AgentEvent 扩展

新增两种事件：

```ts
| { type: "permission_request"; toolUseId; toolName; input; reason }
| { type: "permission_decision"; toolUseId; toolName; decision; reason; persistedTo? }
```

`renderAgentEvent` 在 chat REPL 中把它们渲染成单行 stderr 提示；`runAskWithLLM` 仅在 `decision=deny` 时打印一条，避免刷屏。

---

## 6. 与 claude-code 的差异

| 维度               | claude-code                              | nova-code                                |
| ------------------ | ---------------------------------------- | ---------------------------------------- |
| 规则文件位置       | `.claude/settings.json` 混合其它配置     | 独立 `.nova-code/permissions.json`，失败面小 |
| 规则去重           | `allow-rules` / `deny-rules` 分集        | 单键 `toolName\truleContent`，后覆盖前    |
| Bash 规则粒度      | 命令名 + 参数模式                         | 命令名 + 子命令通配（M3 最小实现）        |
| 子 agent 权限继承  | 继承父 agent 规则                         | 暂未实现（等 M11 AgentTool）             |

---

## 7. 向后兼容

`AgentLoopParams` 的 4 个权限字段 `permissionMode / permissionStore / permissionProvider / cwd` 全部可选；不传时 QueryEngine 行为与 M2 完全一致（全放行）。M3 之前的单测 / 调用方无需改动。

---

## 8. 测试覆盖

- `permissionEngine.test.ts` —— 七步流水线的每条分支
- `permissionStore.test.ts` —— 三层读写 + 文件损坏 + 路径穿越防御
- `denyPatterns.test.ts` / `bashRuleMatcher.test.ts` / `fileRuleMatcher.test.ts`
- `QueryEngine.test.ts` 追加 7 个 smoke tests（关键组合：默认放行 / deny 命中 / ask 无 provider / ask allow-once / ask allow-session / bypass / bypass + DENY_PATTERNS）
- `replPermissionProvider.test.ts` —— 5 档菜单交互 + EOF + 无效输入
- `headlessPermissionProvider.test.ts` —— 一律 deny + stderr 审计
- `slash/permissions.test.ts` —— list / mode / 非法模式 / 未注入兜底
- `parseChatFlags.test.ts` —— 新增 `--dangerously-skip-permissions` 用例

全量：**496 pass, 0 fail**（较 M2 结束时 465 → 本次 +31 pass）。

---

## 9. 后续预留

- `plan` 模式的实际语义要到 M11 AgentTool 再定
- 规则 ruleContent 的 glob 语法（如 `/tmp/**`）是 M4 / M7 级需求
- `/permissions add/remove` 命令行语法暂不开放，走 REPL 菜单
- sub-agent 继承规则要等 M11

---

面向终端用户的操作手册见 [docs/manual/M3-usage-guide.md](../manual/M3-usage-guide.md)。

面向读代码者的实现架构文档见 [docs/architecture/M3/README.md](../architecture/M3/README.md)（6 篇子文件：总览 / engine / store / provider / QueryEngine 三阶段 / chat-ask 集成）。
