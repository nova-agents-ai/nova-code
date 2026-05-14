# M5 — Cost、Config CLI、init 使用手册

> 适用版本：v0.5.x（M5 上线之后）
>
> 面向：终端用户 / 新人上手 / 接入 nova-code 的二次开发者

---

## 1. 前置与安装

参见 [README.md](../../README.md)。M5 不新增 npm 依赖；升级后执行：

```bash
bun install
bun run typecheck
bun test
bun run check
```

---

## 2. 新增命令总览

| 命令 | 作用 | 写入文件 |
|---|---|---|
| `nova-code config get [key]` | 查看持久化配置 | 只读 `~/.nova-code/config.json` |
| `nova-code config set <key> <value>` | 更新持久化配置 | `~/.nova-code/config.json` |
| `nova-code init [--force]` | 在当前目录生成 CLAUDE.md | `./CLAUDE.md` |
| `nova-code cost [--json]` | 汇总历史 chat token 与费用 | 只读 `~/.nova-code/cost.jsonl` |

chat 退出时会自动打印一段 cost 摘要，并把本次 session summary 追加到 `~/.nova-code/cost.jsonl`。

---

## 3. Config CLI

### 3.1 支持的 key

| key | 类型 | 说明 |
|---|---|---|
| `apiKey` | string | Anthropic API key；输出时脱敏 |
| `baseURL` | string | 自定义 Anthropic-compatible endpoint |
| `model` | string | 默认模型 |
| `maxTokens` | positive integer | 单次响应最大 tokens |
| `maxTurns` | positive integer | agent loop 最大轮次 |

### 3.2 设置配置

```bash
nova-code config set apiKey sk-ant-your-key
nova-code config set model claude-sonnet-4-5-20250929
nova-code config set maxTokens 8192
nova-code config set maxTurns 25
```

示例输出：

```text
Set model = claude-sonnet-4-5-20250929
```

### 3.3 读取配置

```bash
nova-code config get
nova-code config get model
nova-code config get apiKey
```

`apiKey` 永远脱敏：

```text
****abcd
```

注意：`config get` 展示的是**持久化配置文件**。运行时 `loadConfig()` 仍按旧优先级解析：

```text
NOVA_API_KEY / NOVA_BASE_URL / NOVA_MODEL > ~/.nova-code/config.json > 内置默认值
```

---

## 4. init：生成 CLAUDE.md

### 4.1 新建

在项目根目录执行：

```bash
nova-code init
```

生成：

```text
./CLAUDE.md
```

内容是一份最小模板：项目指令、交付前校验、保持简洁并用 `@path` 引用长文档。

### 4.2 已存在时的行为

如果当前目录已经有 `CLAUDE.md`：

```bash
nova-code init
```

会返回 1，并提示：

```text
init: CLAUDE.md already exists. Use --force to overwrite.
```

确认要覆盖时：

```bash
nova-code init --force
```

---

## 5. Cost：chat 结束统计与历史汇总

### 5.1 chat 结束时自动打印

```bash
nova-code chat
> hello
ok
> /exit
[cost] Total cost:            $0.0000
[cost] Usage:                 1 input, 1 output, 0 cache read, 0 cache write
[cost] Usage by model:
[cost]   claude-sonnet-4-5-20250929: 1 input, 1 output, 0 cache read, 0 cache write ($0.0000)
```

统计范围：

- 普通 assistant turn；
- 自动 compact 的 LLM summary 调用；
- 手动 `/compact` 的 LLM summary 调用。

### 5.2 查看历史汇总

```bash
nova-code cost
```

输出：

```text
Total cost:            $0.0000
Usage:                 1 input, 1 output, 0 cache read, 0 cache write
Usage by model:
  claude-sonnet-4-5-20250929: 1 input, 1 output, 0 cache read, 0 cache write ($0.0000)
```

### 5.3 JSON 输出

```bash
nova-code cost --json
```

输出结构：

```json
{
  "entries": 1,
  "snapshot": {
    "totalInputTokens": 1,
    "totalOutputTokens": 1,
    "totalCacheReadInputTokens": 0,
    "totalCacheCreationInputTokens": 0,
    "totalCostUsd": 0.000018,
    "usedFallbackPricing": false,
    "models": []
  }
}
```

`models` 实际会包含每个模型的明细；上例省略。

### 5.4 价格说明

M5 的费用是**估算值**，使用内置 Anthropic 价格快照：input/output/cache write/cache read 按每百万 token 计价。价格参考 [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)。未知模型会回退 Sonnet 4.x 档位并显示 fallback 提示。

---

## 6. 端到端可复制验证脚本

以下脚本不打真实 Anthropic API，使用内置 mock transport：

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"
MOCK_LOG="$TMP_HOME/mock-requests.jsonl"

HOME="$TMP_HOME" \
USERPROFILE="$TMP_HOME" \
NOVA_API_KEY="sk-mock" \
NOVA_TRANSPORT="mock" \
NOVA_MOCK_SCENARIO="chat" \
NOVA_MOCK_LOG_FILE="$MOCK_LOG" \
bun run bin/nova-code.ts chat <<'CHAT'
hello
/exit
CHAT

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" bun run bin/nova-code.ts cost
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" bun run bin/nova-code.ts config set model claude-haiku-4-5
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" bun run bin/nova-code.ts config get model
(
  cd "$TMP_HOME"
  bun run /absolute/path/to/nova-code/bin/nova-code.ts init
  test -f CLAUDE.md
)
```

如果在本仓库内运行，把 `/absolute/path/to/nova-code` 换成当前仓库绝对路径，或直接执行：

```bash
REPO="$PWD"
(
  cd "$TMP_HOME"
  bun run "$REPO/bin/nova-code.ts" init
  test -f CLAUDE.md
)
```

---

## 7. 提交前校验矩阵

M5 完成后仍必须跑：

```bash
bun run typecheck
bun test
bun run check
```

本阶段新增关键测试：

| 测试文件 | 覆盖 |
|---|---|
| `src/services/cost/CostTracker.test.ts` | pricing / tracker / ledger |
| `src/commands/CostCommand/CostCommand.test.ts` | cost CLI |
| `src/commands/ConfigCommand/ConfigCommand.test.ts` | config get/set |
| `src/commands/InitCommand/InitCommand.test.ts` | init / --force |
| `src/m5-e2e-cost.test.ts` | chat 退出 cost + ledger |

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `chat: LLM API key not configured` | 没有 `NOVA_API_KEY`，也没写 `apiKey` | `nova-code config set apiKey sk-ant-...` 或 export `NOVA_API_KEY` |
| `config: maxTokens must be a positive integer` | 传了 0 / 负数 / 小数 / 字符串 | 使用正整数，如 `8192` |
| `nova-code cost` 显示 0 | 还没有成功退出过 chat，或 HOME 指到了不同目录 | 先跑一轮 `nova-code chat` 并 `/exit`；确认 `~/.nova-code/cost.jsonl` |
| `[cost] failed to write ledger` | home 目录不可写 / 磁盘权限问题 | 检查 `~/.nova-code/` 权限；chat 本身不会因此失败 |
| `init: CLAUDE.md already exists` | 当前目录已有 CLAUDE.md | 手动编辑现有文件，或确认后用 `nova-code init --force` |
| cost 金额和账单不完全一致 | 内置静态价格 / unknown model fallback / provider 侧计费规则变化 | 以 provider 账单为准；升级价格表或用 `--json` 做自定义汇总 |
