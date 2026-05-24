# M15 使用手册：Plan Mode

> 适用版本：M15 Plan Mode 之后
>
> 面向对象：希望让 nova-code 先产出实现计划、经确认后再改代码的用户。

---

## 1. 前置与安装

```bash
bun install
bun run typecheck
bun test
bun run check
```

M15 不新增外部依赖；运行时仍以 Bun + TypeScript 为准。

---

## 2. 命令总览

### 2.1 chat 中开启 Plan Mode

```bash
nova-code chat
> /plan
> 请实现用户登录
```

或一行提交需求：

```bash
nova-code chat
> /plan 请实现用户登录
```

### 2.2 查看状态

```bash
> /plan status
```

### 2.3 模型提交计划后的审批

模型完成探索后会调用 `ExitPlanMode`，终端会展示计划并询问：

```text
[plan] Approve this plan? (y/n)
```

输入 `y` / `yes` 后进入执行阶段；其他输入或 EOF 视为拒绝，模型仍留在 Plan Mode，需要修订后再次调用 `ExitPlanMode`。

---

## 3. 权限行为

Plan Mode 批准前强制拦截：

| 工具 | 批准前 | 批准后 |
|---|---|---|
| `Bash` | 拒绝 | 恢复进入前权限模式 |
| `FileWrite` | 拒绝 | 恢复进入前权限模式 |
| `FileEdit` | 拒绝 | 恢复进入前权限模式 |
| `LS` / `FileRead` / `Grep` / `Glob` | 可用 | 可用 |
| `Agent` 的 `explore` / `plan` 子类型 | 只读可用 | 只读可用 |

如果你用 `nova-code chat --dangerously-skip-permissions` 启动，Plan Mode 批准前仍会拦截写权工具；批准后恢复 bypass。

---

## 4. 端到端可复制验证脚本

在 nova-code 仓库根目录执行：

```bash
set -euo pipefail

TMP_DIR="$(mktemp -d)"
BIN_PATH="$PWD/bin/nova-code.ts"

(
  cd "$TMP_DIR"
  HOME="$TMP_DIR" \
  USERPROFILE="$TMP_DIR" \
  NOVA_API_KEY="sk-mock" \
  NOVA_TRANSPORT="mock" \
  NOVA_MOCK_SCENARIO="plan-loop" \
  NOVA_WEB_PROXY="" \
  NOVA_WEB_PROXY_DOMAINS="" \
  bun "$BIN_PATH" chat --dangerously-skip-permissions <<'INPUT'
/plan implement the approved marker file
y
/exit
INPUT

  test "$(cat plan-output.txt)" = "M15_PLAN_APPROVED"
)

echo "M15 Plan Mode e2e OK"
```

该脚本验证：

1. `/plan <prompt>` 会进入 Plan Mode 并提交需求。
2. mock 模型通过 `ExitPlanMode` 请求批准。
3. 用户输入 `y` 后，模型才能调用 `FileWrite` 创建文件。

---

## 5. 常见用法

### 5.1 复杂变更先审计划

```bash
nova-code chat
> /plan 重构 src/services/mcp，降低 stdio/http client 的重复代码
```

建议在批准前重点检查：涉及文件、兼容性、测试策略、是否需要迁移文档。

### 5.2 拒绝计划并要求修订

当审批提示出现时输入 `n`。当前版本不会再追问原因；你可以下一轮直接补充：

```text
这个计划太大，请先只做 stdio client 的无行为重构。
```

模型仍在 Plan Mode，写权工具继续被拦截。

### 5.3 只查看状态

```bash
> /plan status
```

会展示当前状态、批准后恢复的权限模式，以及最近的 approved / pending / rejected plan 摘要。

---

## 6. 提交前校验矩阵

| 命令 | 必须通过 | 说明 |
|---|---|---|
| `bun run typecheck` | ✅ | 校验 PlanModeRuntime / ToolExecutionContext 类型边界 |
| `bun test` | ✅ | 包含 M15 unit/e2e 与既有回归 |
| `bun run check` | ✅ | Biome lint + format |

---

## 7. 故障排查

| 现象 | 可能原因 | 处理方式 |
|---|---|---|
| `[tool] Bash failed: Permission denied: plan mode blocks...` | 仍在 Plan Mode，计划未批准 | 等模型调用 `ExitPlanMode`，批准后再执行 |
| `ExitPlanMode can only be used while Plan Mode is active` | 模型未进入 Plan Mode 就调用退出工具 | 先输入 `/plan` 或让模型调用 `EnterPlanMode` |
| 批准后仍询问 FileWrite 权限 | 进入 Plan Mode 前是 `default` 模式 | 这是预期；批准 plan 不等于跳过所有普通权限，可选择具体工具授权 |
| headless `ask` 里 plan 被拒绝 | ask 没有交互式审批 provider | 用 `chat` 走 `/plan`；或改成普通 ask 任务 |
| `/plan <prompt>` 没继续执行 | prompt 为空或被内置 slash 当作状态查看 | 确认 `/plan` 后面有实际需求文本 |

---

## 8. 交叉引用

- [M15 设计文档](../design/M15-plan-mode.md)
- [M15 架构文档](../architecture/M15-architecture.md)
- [Roadmap](../roadmap.md)
