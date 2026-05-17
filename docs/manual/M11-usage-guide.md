# M11 使用手册 — AgentTool 子 agent 派生

> 面向终端用户 / 新人上手。M11 让模型可调用 `Agent` 工具，把独立调研或实现子任务交给子 agent；主对话只接收子 agent 最终摘要。

---

## 1. 前置条件

- Bun >= 1.3；
- 已配置 `NOVA_API_KEY`，或使用 `NOVA_TRANSPORT=mock` 做本地验证；
- 通过 `nova-code ask` 或 `nova-code chat` 使用。

无需新增配置，也不需要升级 `package.json` 版本号。

---

## 2. 什么时候会用 AgentTool

适合：

- 大量搜索 / 文件读取会污染主上下文的调研；
- 需要独立第二意见的代码审查；
- 可明确边界的子任务，例如“只检查 config 加载链路”；
- 可并行拆分但结果只需摘要的工作。

不适合：

- 下一步立即依赖子任务中间细节；
- 需要与用户持续交互的任务；
- 必须隔离工作区的高风险改动（M11 还没有 worktree 隔离）。

---

## 3. 可用子 agent 类型

| 类型 | 用途 | 工具池 |
|---|---|---|
| `general-purpose` | 默认类型，适合一般实现/调研 | 父工具池移除 `Agent` 和 `TodoWrite` |
| `explore` | 只读探索 | LS / FileRead / Grep / Glob / WebFetch / WebSearch / Skill |

普通用户不需要手动写 JSON；模型会按工具 schema 调用。

---

## 4. 示例用法

### ask：让模型自行委派

```bash
nova-code ask "请调查配置加载链路，必要时把细节委派给子 agent，最终给我结论"
```

如果模型选择委派，你会在 stderr 看到类似：

```text
[tool] Agent {"description":"Inspect config loading", ...}
```

stdout 最终仍是父 agent 的回答；子 agent 的中间工具输出不会直接出现在主上下文。

### chat：多轮中委派

```bash
nova-code chat
> 先让子 agent 调研 hooks 和 permission 的集成点，然后你再给我实施建议
```

子 agent 内部的文件读取、搜索、权限判断与 hooks 都复用当前 chat 会话配置。

---

## 5. 权限与安全

`Agent` 工具本身默认不需要审批；真正的写文件、改文件、运行 Bash 等动作仍由子 agent 内部工具触发原有权限系统。

- `ask` 默认 `acceptEdits`：文件编辑可自动允许，Bash 仍会被 headless provider 拒绝，除非使用已有规则或 `--dangerously-skip-permissions`。
- `chat` 默认 `default`：需要审批的工具会继续询问用户。
- M10 hooks 会同时看到父层 `Agent` 调用和子 agent 内部工具调用。

---

## 6. 端到端可复制验证脚本

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
  NOVA_API_KEY=sk-mock \
  NOVA_TRANSPORT=mock \
  NOVA_MOCK_SCENARIO=agent-loop \
  bun run bin/nova-code.ts ask "delegate this lookup to an agent" \
  >"$TMP_HOME/stdout.txt" 2>"$TMP_HOME/stderr.txt"

grep "Done. Agent completed." "$TMP_HOME/stdout.txt"
grep "\[tool\] Agent" "$TMP_HOME/stderr.txt"
rm -rf "$TMP_HOME"
```

---

## 7. 提交前校验矩阵

```bash
bun run typecheck
bun test
bun run check
```

M11 重点测试可单独运行：

```bash
bun test src/QueryEngine.test.ts
bun test src/m11-e2e-agent.test.ts
```

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 没看到 `[tool] Agent` | 模型判断无需委派 | 明确要求“可以使用 Agent 子任务”或使用 mock 验证 |
| 子 agent 报权限拒绝 | 子 agent 内部工具触发 M3 权限系统 | 在 chat 中按提示允许，或配置 permission rule |
| 子 agent 没有改文件 | 使用了 `explore` 类型 | 让模型使用默认 `general-purpose`，并在 prompt 中明确允许修改 |
| 输出被截断 | 子 agent 摘要超过 30,000 字符 | 要求子 agent 报告更短、聚焦文件/结论 |

---

## 9. 交叉引用

- [M11 设计文档](../design/M11-agent-tool.md)
- [M11 架构文档](../architecture/M11-architecture.md)
- [Roadmap](../roadmap.md)
