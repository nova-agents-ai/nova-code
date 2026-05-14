# nova-code 架构文档 · M4

> 适用版本：M4 完成之后（上下文压缩 + CLAUDE.md 注入上线）
> 基线提交：2026-05-12
> 文档目标：让读者半小时内理解一次自动 compact 与一次 /compact 的完整链路、CLAUDE.md 的 4 层加载机制、以及向后兼容的设计

---

## 目录

M4 在 M3 之上新增 `src/services/compact/` 与 `src/services/projectInstructions/` 两个子系统，并在 QueryEngine 主循环、ChatSession、AskCommand、ChatCommand REPL 上插桩。

| # | 文档 | 读完你会知道 |
|---|---|---|
| 1 | [overview.md](./overview.md) | M4 子系统全景 + 与 M3 的耦合点 + AgentEvent 扩展 |
| 2 | [compact-pipeline.md](./compact-pipeline.md) | compactConversation 主路径 + partialCompactConversation 回退 + 错误清单 |
| 3 | [auto-compact.md](./auto-compact.md) | 阈值算式 + usage 锚点估算 + circuit breaker 状态机 |
| 4 | [project-instructions.md](./project-instructions.md) | 4 层 CLAUDE.md 加载顺序 + @include 算法 + 循环检测 |
| 5 | [query-engine-integration.md](./query-engine-integration.md) | runAgentLoop 在哪里插桩、如何替换 messages、如何透传 system/tools 与 tracking |

---

## 设计哲学（M4 增量条目）

承继 M0 / M1.5 / M2 / M3 原则，M4 再添三条：

15. **失败即 no-op，不阻断 agent loop**：自动 compact 失败应静默重试或降级，绝不上抛打断主循环；只有手动 /compact 抛错让用户看到。`autoCompactIfNeeded` 用 `try/catch` 把所有非 abort 错都吞掉，仅记到 `consecutiveFailures` 与 compact_end 事件的 error 字段。
16. **token 估算优于 token 精算**：tokenizer 库会引入额外依赖与 N MB 的词表数据。M4 用"最近 assistant message 上的 SDK usage 锚点 + 之后 chars/4 估算"足够支撑阈值判定 —— 偏一点点不影响触发时机的合理性，回避了引入 tokenizer 的成本。
17. **可选注入 + 默认开启的双轨制**：`AgentLoopParams` 的 compact / projectInstructions 字段全部可选（保证 M3 既有测试 0 改动），但 chat / ask 命令默认全开 —— 终端用户得到默认安全的体验，库使用者保留细粒度控制权。

---

## 与历史文档的关系

- [`docs/architecture/M0-architecture.md`](../M0-architecture.md)：M0 单文件快照，历史回溯
- [`docs/architecture/M1.5/README.md`](../M1.5/README.md)：M1.5 入口（runAgentLoop / Tool 接口 / services/api 封装）
- [`docs/architecture/M2/README.md`](../M2/README.md)：M2 入口（ChatSession / runChatRepl / 斜杠命令体系）
- [`docs/architecture/M3/README.md`](../M3/README.md)：M3 入口（权限七步流水线 / 三层规则）
- [`docs/design/M4-compact.md`](../../design/M4-compact.md)：M4 设计稿（为什么这么做）
- [`docs/manual/M4-usage-guide.md`](../../manual/M4-usage-guide.md)：M4 使用手册（如何使用）
- [`docs/roadmap.md`](../../roadmap.md)：整体路线图，M4 完成后处于 v0.3.x 阶段

---

## 如何为本套文档做贡献

- **M4 阶段内增删 `src/services/compact/` / `src/services/projectInstructions/` / QueryEngine 的 compact 集成代码** → 必须同步更新本套文档
- **M4+ 的新增特性** → 在 `docs/architecture/M<n>/` 下新开一套；不要往 M4 里塞
- **不要改 M0 / M1.5 / M2 / M3 / M4 等历史快照** —— 它们反映对应版本的状态
