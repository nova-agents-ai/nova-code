# nova-code 架构文档

> 适用版本：M1.5 完成之后的工程状态（src/ 目录结构已对齐 claude-code 同位命名）
> 基线提交：2026-05（见 `docs/roadmap.md` v2.3）
> 文档目标：让新读者在 1 小时内从零读懂 `bin/nova-code.ts` → 工具执行的完整链路

---

## 目录

这套架构文档按"自顶向下 + 侧写"组织，建议按下面顺序通读；每篇都能独立速查。

| # | 文档 | 读完你会知道 |
|---|---|---|
| 1 | [overview.md](./overview.md) | 整个工程的分层、目录结构、关键模块的职责、单向依赖图、一次 `ask` 请求的完整时序 |
| 2 | [commands-and-cli.md](./commands-and-cli.md) | `bin/nova-code.ts` → `runCli` → `CommandDefinition` 的分发机制；`hello` / `echo` / `ask` 三个内置命令；`ask` 的 flag 解析 / debug sink / 错误退出码 |
| 3 | [agent-loop.md](./agent-loop.md) | `src/QueryEngine.ts` 的多轮对话循环、`AgentEvent` 事件体系、tool_use 并行执行、错误归一化、`maxTurns` 保护 |
| 4 | [services-api.md](./services-api.md) | Anthropic SDK 客户端封装、`LLMApiError` 错误层、`isRetryableError` 分类、`withRetry` 的指数退避算法 |
| 5 | [tools.md](./tools.md) | `Tool` 接口、7 个内置工具（`LS` / `FileRead` / `FileWrite` / `FileEdit` / `Bash` / `Grep` / `Glob`）各自的安全约束、截断策略、共享常量 |
| 6 | [config-and-errors.md](./config-and-errors.md) | 配置优先级（env > 文件 > 默认）、`~/.nova-code/config.json`、5 类错误的归类与退出码映射 |
| 7 | [testing.md](./testing.md) | `FakeClient` 脚本化 SDK mock、`scripts/mock-anthropic.ts` 的 SSE 剧本、集成测试的跨进程验证范式 |

---

## 设计哲学（先读这几条再看代码）

1. **分层单向依赖**：`CLI → Command → QueryEngine → {Services, Tools, Config, Errors, Types}`。下层永远不依赖上层，叶子层（`errors/` / `types/`）零依赖。
2. **薄类型**：不把 Anthropic SDK 的巨型联合类型（`ContentBlockParam` 有 25+ 变体）暴露给上层，只定义 nova-code 关心的子集（`NovaMessage` / `NovaContentBlock` / `AgentEvent`）。SDK 类型只在 `services/api/client.ts` 与 `QueryEngine.ts` 内部流转。
3. **事件流而非副作用**：`runAgentLoop` 返回 `AsyncGenerator<AgentEvent, NovaMessage>`；所有"写 stdout / stderr / 日志文件"的决策都留给消费方（`runAskWithLLM` 是其中一个，未来 REPL 可以是另一个）。
4. **错误语义化**：5 类错误 ↔ 4 种退出码（`AbortError=130` / `ConfigError=1` / `MaxTurnsExceededError / LLMApiError / ToolExecutionError / Error=2`）。退出码是 CLI 与 shell 脚本通信的唯一契约。
5. **约束优先于能力**：工具的"不能做什么"比"能做什么"更值得写进 description。例如 `FileEdit` 强制 `old_string` 在文件中恰好出现一次、`FileWrite` 只创建不覆盖、`Bash` 硬黑名单拒绝 `rm -rf /`。这些约束降低了模型走错路径的概率。
6. **节奏由完成度驱动**：每个 milestone 只做该阶段必须的事情。例如 M1 不做权限审批（`requiresApproval` 只埋字段不消费）、`withRetry` 已写好但 `QueryEngine` 暂不强制走它。

---

## 与历史文档的关系

- [`docs/architecture/M0-architecture.md`](./M0-architecture.md)：M0 时期快照，描述的是 `src/llm/` 还存在的结构。M1.5 之后 `src/llm/` 已被拆散到 `src/types/` / `src/errors/` / `src/services/api/` / `src/QueryEngine.ts`。**仅供历史回溯阅读**。
- [`docs/design/M1-tools.md`](../design/M1-tools.md)：M1 工具系统的设计过程稿，含 v2.2 评审记录与取舍理由。实现细节以本套架构文档为准。
- [`docs/design/M1.5-refactor.md`](../design/M1.5-refactor.md)：M1.5 重构窗口的执行总结，记录了每个文件的搬迁路径。
- [`docs/roadmap.md`](../roadmap.md)：整体路线图（15 个 milestone，当前位于 Phase 1 M1.5 → M2 过渡期）。

---

## 如何为本套文档做贡献

- **代码改动同步更新**：当你增删 `src/` 下的顶层模块、修改 `Tool` 接口、或调整 `AgentEvent` 事件语义时，必须同步更新 [overview.md](./overview.md) 的依赖图与类型定义。
- **不要改 M0-architecture.md**：它是历史快照，不再演进。
- **新增 milestone 总结**：在 `docs/design/` 下归档（如 `M2-chat-repl.md`），不要塞进 `architecture/`。`architecture/` 只描述"当前状态"。
