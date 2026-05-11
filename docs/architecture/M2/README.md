# nova-code 架构文档 · M2

> 适用版本：M2 完成之后（chat REPL 已上线，覆盖多轮对话 + 斜杠命令 + JSONL 会话持久化 + LLM 原始请求/响应日志）
> 基线提交：2026-05
> 文档目标：让读者在半小时内从 `nova-code chat` 启动到 `/exit` 退出的完整链路形成准确心智模型

---

## 目录

M2 在 M1.5 的基础上新增了完整的 `ChatCommand/` 子系统。文档按"自顶向下 + 侧写"组织，建议依序通读。每篇可独立速查。

| # | 文档 | 读完你会知道 |
|---|---|---|
| 1 | [overview.md](./overview.md) | `ChatCommand/` 子系统全景、与 `AskCommand/` 的并列关系、一次 `chat` REPL 的完整时序、AgentEvent → ChatSession 的事件重建映射 |
| 2 | [chat-session.md](./chat-session.md) | `ChatSession` 的"本地快照 + 成功才提交"原子性机制、`sendTurn` 的事件重建规则、`clear/snapshot/restore` 的用途 |
| 3 | [repl-loop.md](./repl-loop.md) | `runChatRepl` 的 readline AsyncIterator、TTY/非 TTY 双路 SIGINT 监听、"idle / streaming / pending-exit"三态状态机、`renderAgentEvent` 的共享渲染 |
| 4 | [session-store.md](./session-store.md) | `sessionId` 生成规则、JSONL 持久化格式（`kind: meta/msg`）、`/save`/`/load`/`--resume` 三路径、`assertSafeFileName` 防目录穿越、alias 文件副本策略 |
| 5 | [slash-commands.md](./slash-commands.md) | `SlashCommand` / `SlashContext` / `SlashIO` / `SlashResult` 四件套、dispatcher 的解析规则、registry 如何用工厂避开循环依赖、5 个内置命令（`/clear` `/exit` `/save` `/load` `/help`）的实现取舍 |
| 6 | [llm-debug-log.md](./llm-debug-log.md) | `LlmLogSink` 最小接口、`llm_request` / `llm_response` / `llm_error` 三事件、`debugSink` 的 `prefix` + `sessionId` 参数矩阵、`initialMessages` 如何让 `runAgentLoop` 支持多轮上下文 |

---

## 设计哲学（M2 增量条目）

承继 M1.5 六条原则，M2 再添四条：

7. **原子提交优于乐观写入**：多轮对话中的 `user → assistant(tool_use) → tool_result user → ...` 必须严格配对，否则下一轮会被 SDK 拒。`ChatSession.sendTurn` 用"本地快照 newMessages + 成功才 `this.messages = newMessages`"的模式，把失败路径的脏状态自动回滚——这套模式同样适用于未来任何需要"中间步骤产生临时状态"的业务。
8. **Kind 字段作为可演进的 discriminator**：JSONL 首行用 `{"kind":"meta"}`、其余行用 `{"kind":"msg"}`，不用"首行特例"而用显式 kind。未来插入 `snapshot marker`、`context summary` 等新类型时只扩枚举，旧读者按"只收自己认识的 kind"继续工作。
9. **状态机优先于 boolean 组合**：SIGINT 在 REPL 中同时意味着"取消当前流"、"首次按下进入待确认"、"1.5s 内再按一次退出"。用三态 tagged union 表达比 `boolean cancellable + number firstPressAt` 的 ad-hoc 组合更易于推理，也避免"并发重入"隐患。
10. **日志分层**：AgentEvent 日志（语义流）与 LLM 原始请求/响应日志（协议流）各写一份文件。前者回放业务行为，后者排查 SDK 层、模型层协议问题——两者信息密度和消费者完全不同，混在一起反而降低可读性。

---

## 与历史文档的关系

- [`docs/architecture/M0-architecture.md`](../M0-architecture.md)：M0 快照，仅供历史回溯。
- [`docs/architecture/M1.5/README.md`](../M1.5/README.md)：M1.5 文档入口（7 篇）。M2 是增量，**不重复**描述 M1.5 已覆盖的 `runAgentLoop` 主循环、工具体系、services/api 封装等内容——读 M2 任一篇前建议先通读 M1.5 的 [overview.md](../M1.5/overview.md)。
- [`docs/manual/M2-usage-guide.md`](../../manual/M2-usage-guide.md)：M2 的使用手册（端到端验证示例）。本套架构文档描述"如何实现"，使用手册描述"如何使用"。
- [`docs/roadmap.md`](../../roadmap.md)：整体路线图，当前处于 M2 完成、M6.5 规划中的过渡期。

---

## 如何为本套文档做贡献

- **M2 阶段内增删 `src/commands/ChatCommand/`** → 必须同步更新本套文档。
- **M3+ 的新增特性** → 在 `docs/architecture/M<n>/` 下新开一套；不要把新能力塞进 M2 文档让它"变厚"。架构文档按 milestone 分目录，反映的是"某一版本状态"，不是"当前版本状态"。
- **不要改 M0 / M1.5 的文档** → 它们是历史快照。
