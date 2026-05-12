# nova-code 架构文档 · M3

> 适用版本：M3 完成之后（权限与安全上线，七步流水线 + 三层规则 + 四档模式 + REPL 5 档弹窗 + headless auto-deny + `--dangerously-skip-permissions`）
> 基线提交：2026-05-04
> 文档目标：让读者在半小时内从 `nova-code chat` 启动到一次 `tool_use` 被询问/放行/拒绝的完整链路形成准确心智模型

---

## 目录

M3 在 M2 之上新增 `src/services/permissions/` 子系统 + QueryEngine 三阶段流水线 + chat/ask 命令入口的权限注入。文档按"总览 → 核心域 → 组装"组织。

| # | 文档 | 读完你会知道 |
|---|---|---|
| 1 | [overview.md](./overview.md) | M3 子系统全景图、`src/` 目录增量、领域类型（Mode / Rule / Source / Choice / Decision）、一次 `tool_use` 穿过权限层的完整时序 |
| 2 | [permission-engine.md](./permission-engine.md) | `evaluatePermission` 七步流水线的每一条分支、`DENY_PATTERNS` 清单与为什么连 bypass 都不绕、Bash / File 两套 matcher 的语义边界 |
| 3 | [permission-store.md](./permission-store.md) | `PermissionStore` 三层存储语义、`.nova-code/permissions.json` 持久化 schema、`upsertRule` 去重键、load/addRule 的并发与文件 IO 边界 |
| 4 | [permission-provider.md](./permission-provider.md) | `PermissionProvider` 接口形状、REPL 5 档弹窗实现 + 安全从严 fallback、headless auto-deny 实现、`decisionFromUserChoice` 映射表 |
| 5 | [query-engine-phases.md](./query-engine-phases.md) | QueryEngine 从 M2 "并行 execute" 变成 M3 Phase A 串行权限判定 + Phase B 并行 execute + Phase C 按序组装的原因、新增 AgentEvent 事件、向后兼容策略 |
| 6 | [chat-ask-integration.md](./chat-ask-integration.md) | `ChatCommand` 的 `PermissionModeRef` 可变 ref 与 `/permissions` 斜杠命令、`AskCommand` 的默认 acceptEdits + stderr 审计、`--dangerously-skip-permissions` flag 的两条不同路径 |

---

## 设计哲学（M3 增量条目）

承继 M0 / M1.5 / M2 的原则，M3 再添四条：

11. **深度防御优于单层拦截**：DENY_PATTERNS 即便在 `bypassPermissions` 模式下也不放开；`BashTool` 自身 `HARD_BANNED_PATTERNS` 再在执行前校一次。两道防线信息同步但独立部署，任一层失效不会导致灾难命令落地。
12. **纯函数引擎 + 有状态外壳**：`evaluatePermission` 是无副作用的纯函数，所有输入（mode / rules / requiresApproval / cwd）由调用方显式传入——这让 engine 可在单测里穷举七步分支，而把 IO、弹窗、文件写回、事件发送这些副作用全部留给 `PermissionStore` + `PermissionProvider` + `QueryEngine`。
13. **Source 分层但 deny 扁平**：allow 规则按 `session > project > global` 有优先级（越"近"越强），但 deny 规则**任何层命中即生效**。这是"安全从严"原则的直接体现：用户任何一层声明的拒绝都不应被覆盖。
14. **可运行时切换的 mode 通过可变 ref 传递**：chat REPL 允许 `/permissions mode <m>` 在运行中改权限模式。用 `PermissionModeRef = { get, set }` 的小闭包传给 `dispatchSlash` 和 `sendTurn`，而不是把 mode 塞进事件循环的每一个参数——避免"半路改了 mode 有些地方还读旧值"的同步问题。

---

## 与历史文档的关系

- [`docs/architecture/M0-architecture.md`](../M0-architecture.md)：M0 单文件快照，历史回溯。
- [`docs/architecture/M1.5/README.md`](../M1.5/README.md)：M1.5 入口（7 篇）。M3 引用的 `runAgentLoop` 主循环、`Tool` 接口、`services/api` 封装均在 M1.5 文档中详述，**不在 M3 重复**。
- [`docs/architecture/M2/README.md`](../M2/README.md)：M2 入口（6 篇）。M3 共用 M2 的 `ChatCommand/` 骨架（`ChatSession` / `runChatRepl` / 斜杠命令体系 / debugSink），本套文档只描述 M3 在此之上的增量点。
- [`docs/design/M3-permissions.md`](../../design/M3-permissions.md)：M3 设计决策稿（七步流水线为何按这个顺序、与 claude-code 的差异、后续预留）。本套文档描述"如何实现"，设计稿描述"为何如此设计"。
- [`docs/manual/M3-usage-guide.md`](../../manual/M3-usage-guide.md)：M3 使用手册（端到端验证示例、故障排查）。本套文档描述"如何实现"，手册描述"如何使用"。
- [`docs/roadmap.md`](../../roadmap.md)：整体路线图，当前处于 M3 完成、M4 未启动状态。

---

## 如何为本套文档做贡献

- **M3 阶段内增删 `src/services/permissions/` 或 `QueryEngine` 权限相关代码** → 必须同步更新本套文档。
- **M4+ 的新增特性** → 在 `docs/architecture/M<n>/` 下新开一套；不要往 M3 里塞。
- **不要改 M0 / M1.5 / M2 / M3 等历史快照** → 它们反映对应版本的状态。
