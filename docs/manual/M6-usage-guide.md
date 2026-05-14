# M6 — TodoWrite 使用手册

> 适用版本：v0.6.x（M6 上线之后）
>
> 面向：终端用户 / 新人上手 / 接入 nova-code 的二次开发者

---

## 1. 前置与安装

M6 不新增 npm 依赖。升级后执行：

```bash
bun install
bun run typecheck
bun test
bun run check
```

---

## 2. 新增能力总览

| 能力 | 说明 |
|---|---|
| `TodoWrite` 工具 | 模型可维护当前任务的 todo list |
| system prompt 引导 | 多步骤 / 多文件任务时鼓励模型先规划 |
| ASCII 渲染 | `ask` / `chat` 中可见当前任务表 |
| mock e2e 场景 | `NOVA_MOCK_SCENARIO=todo-loop` 可离线验证 |

你不需要手动输入 `TodoWrite`；它是给模型调用的内部工具。

---

## 3. 典型使用

### 3.1 ask 模式

```bash
NOVA_API_KEY="sk-ant-..." bun run bin/nova-code.ts ask "请重构 src 下的多个模块并补测试"
```

当模型判断任务足够复杂时，stderr 会出现类似输出：

```text
[tool] TodoWrite {"todos":[...]}
Todos have been modified successfully. Continue using the todo list to track progress.

Current todos:
[x] 1. Inspect project structure
[*] 2. Implementing changes across files
[ ] 3. Run verification
```

### 3.2 chat 模式

```bash
NOVA_API_KEY="sk-ant-..." bun run bin/nova-code.ts chat
> 请分三步完成一次跨文件改造：先读结构，再改实现，最后跑校验
```

`TodoWrite` 成功结果会输出到 stderr；普通只读 / 写文件工具的成功结果仍保持静默，避免噪音。

---

## 4. 离线端到端验证脚本

以下脚本不访问真实 Anthropic API：

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"

HOME="$TMP_HOME" \
USERPROFILE="$TMP_HOME" \
NOVA_API_KEY="sk-mock" \
NOVA_TRANSPORT="mock" \
NOVA_MOCK_SCENARIO="todo-loop" \
bun run bin/nova-code.ts ask "implement a multi-file feature" \
  >"$TMP_HOME/stdout.txt" \
  2>"$TMP_HOME/stderr.txt"

grep -q "Done. TodoWrite tracked" "$TMP_HOME/stdout.txt"
grep -q "\[tool\] TodoWrite" "$TMP_HOME/stderr.txt"
grep -q "Current todos:" "$TMP_HOME/stderr.txt"
grep -q "\[\*\] 2. Implementing changes across files" "$TMP_HOME/stderr.txt"

echo "M6 TodoWrite e2e ok"
```

---

## 5. 提交前校验矩阵

| 命令 | 期望 |
|---|---|
| `bun run typecheck` | TypeScript 严格模式通过 |
| `bun test` | 全量单测 / 集成 / e2e 通过 |
| `bun run check` | Biome lint + format 通过 |

M6 完成时全量为 631 tests。

---

## 6. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 模型没有调用 TodoWrite | 任务太简单，或模型判断无需规划 | 对跨文件 / 多步骤任务重试；M6 只是 prompt 引导，不强制工具调用 |
| stderr 没有任务表 | 模型未调用工具，或工具调用失败 | 开 `--debug` 看 AgentEvent；确认 `TodoWrite` 在 `builtinTools` |
| 出现 “at most one in_progress” | 模型提交了多个进行中任务 | 工具会把错误回传给模型，下一轮通常会自我修正 |
| 全部 completed 后下一次为空 | 设计如此；全部完成会清空内存任务表 | 无需处理 |

---

## 7. 交叉引用

- [M6 设计文档](../design/M6-todowrite.md)
- [M6 架构文档](../architecture/M6-architecture.md)
- [Roadmap](../roadmap.md)
