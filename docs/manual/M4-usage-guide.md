# M4 — 上下文压缩 + CLAUDE.md 使用手册

> 适用版本：v0.3.x（M4 上线之后）
>
> 面向：终端用户 / 接入 nova-code 库的二次开发者

---

## 1. 前置与安装

参见 [README.md](../../README.md) 的安装章节。M4 引入了一个运行时依赖 `marked`（markdown lexer，用于 CLAUDE.md @include 解析），从 v0.2.x 升级时执行 `bun install` 即可拉到。

环境变量速查（M4 新增）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NOVA_DISABLE_TELEMETRY` | 未设 | 设为 `1` 或 `true` 关闭所有 logEvent 埋点（含环形 buffer 与文件落盘） |
| `NOVA_TELEMETRY_FILE` | 未设 | 设为绝对路径时，每条 `tengu_*` 事件会以 JSONL 形式追加到该文件 |
| `NOVA_MOCK_INFLATE_USAGE` | `0` | 仅 `NOVA_TRANSPORT=mock` 下生效；把 mock 响应的 `usage.input_tokens` 强制为该值，用于 e2e 触发自动 compact 阈值 |

---

## 2. 这一阶段你能做什么

| 能力 | 命令 / 入口 | 默认行为 |
|---|---|---|
| 自动上下文压缩 | `nova-code chat` / `nova-code ask` | 默认开启；token 估算 ≥ 167K 时自动 compact |
| 手动压缩 | REPL 内 `/compact [自定义指令]` | 强制 compact 当前会话 |
| CLAUDE.md 注入 | 在 cwd / git root / `~/.nova-code/` 放 `CLAUDE.md` | 启动时自动加载并拼到 system prompt |
| @include 子文件 | 在 CLAUDE.md 里写 `@./extra.md` | 递归加载，深度上限 5，循环检测 |

---

## 3. 配置

M4 的两个关键开关都是默认开启，无需配置。如需关闭可通过环境变量或代码参数。

### 3.1 关闭自动 compact

目前没有 CLI flag，需通过 lib 调用：

```ts
import { runAgentLoop } from "nova-code";

await runAgentLoop({
  config,
  userPrompt: "...",
  tools: [],
  autoCompactEnabled: false,  // ← 关闭自动 compact
});
```

`nova-code chat` 现版本默认全开；如需 CLI flag 可在后续 milestone 加。

### 3.2 不注入 CLAUDE.md

`getProjectInstructions()` 找不到任何 CLAUDE.md 即返回 undefined，运行时安全；不需要主动关闭。

---

## 4. 自动 compact 怎么运作

### 4.1 阈值

```
模型上下文窗口（claude-sonnet-4-5）   200,000 tokens
- summary 输出预留                     20,000
- 安全余量                              13,000
─────────────────────────────────────
自动触发阈值                          167,000 tokens
```

每轮 `streamOneTurn` 之前 nova-code 会用 `tokenCountWithEstimation` 估算当前 messages 的 token 数：
- 锚点 = 从 messages 末尾向前找到的最近一条 assistant `usage.input + cache + output`
- 锚点之后新增 messages 的 token 数 = `chars / 4`（向上取整）

≥ 167K → 触发自动 compact。

### 4.2 你会看到什么

REPL stderr 会出现两行进度：

```
[compact] auto-compacting (≈ 168432 tokens)
[compact] done: 168432 → 612 tokens
```

随后下一轮模型回复就在新的（极短的）上下文上继续，就像没 compact 过一样。

### 4.3 失败兜底

- 单次失败：`[compact] failed: <message>`，agent loop 继续，下一轮会再试
- 连续 3 次失败：本会话停用自动 compact（circuit breaker），手动 `/compact` 仍可用

---

## 5. 手动 /compact

### 5.1 最简形式

```
> /compact
已压缩 12 条消息 → 1 条 summary (≈ 8420 → 612 tokens)
```

`messages` 立即被替换；后续对话从压缩点继续。

### 5.2 自定义指令

```
> /compact focus on test files and Bash commands
已压缩 12 条消息 → 1 条 summary (≈ 8420 → 738 tokens)
```

`focus on test files and Bash commands` 会被拼到 compact prompt 的 `Additional Instructions:` 段，引导模型在 summary 中重点保留这部分上下文。

### 5.3 什么时候用

- 你看到 `[compact] auto-compacting` 之后想确认压缩效果
- 当前对话还远未到阈值，但你想换话题，希望模型"忘记"前面的细节
- 想给压缩附加一些自定义指令（比如保留某些关键决策）

---

## 6. CLAUDE.md 项目指令

### 6.1 4 层加载顺序（由低到高）

| 层级 | 路径 | 用途 |
|---|---|---|
| managed | `/etc/nova-code/CLAUDE.md` | 系统管理员强制规则（Linux/macOS；Windows 跳过） |
| user | `~/.nova-code/CLAUDE.md` | 跨项目个人偏好 |
| project chain | `<gitRoot>/CLAUDE.md`、`<gitRoot>/.nova-code/CLAUDE.md`，再到 `<cwd>` 每层 | 项目级（受 git 管理，团队共享建议） |
| local chain | `<gitRoot>/CLAUDE.local.md`，再到 `<cwd>` 每层 | 个人本地覆盖（建议加到 .gitignore） |

每层都可以同时存在；后加载的优先级更高（拼接结果中靠后），模型会更关注。

### 6.2 一份最小例子

`./CLAUDE.md`：
```markdown
# Project: my-cli

This is a Bun + TypeScript CLI. When editing this repo:
- Always use `bun add` for new deps; never `npm install`.
- Functions ≤ 30 lines; split helper modules eagerly.
- Tests use `bun:test`; new files are `*.test.ts` next to the source.

@./.nova-code/extra-conventions.md
```

`./.nova-code/extra-conventions.md`：
```markdown
- All public exports must have explicit return types.
- Never use `any`; prefer `unknown` + type narrowing.
```

启动 `nova-code chat`，模型会同时看到两份内容拼好的指令。

### 6.3 @include 路径形式

| 写法 | 含义 |
|---|---|
| `@./relative.md` | 相对于当前文件目录 |
| `@relative.md` | 同上（缺省 `./`） |
| `@../up.md` | 父目录 |
| `@/abs/path.md` | 绝对路径（非纯 `/`） |
| `@~/home/x.md` | 用户 home 目录 |
| `@./has\ space.md` | 转义空格 → 字面空格 |

规则（claude-code 同款，由 marked Lexer 实现）：
- 行首 / 空格后的 `@path` 都算 include —— **inline 也支持**（如 "see @./inline.md for details"）
- ``` ``` 或 `~~~` fenced code block 内的 `@path` 跳过（lexer 识别 `code` token）
- inline `` `@./foo.md` `` 内的 `@path` 跳过（lexer 识别 `codespan` token）
- 取 `#` 之前的部分作为路径（剥 fragment / heading anchor）
- 拒绝非法形态：纯 `@/`、`@@nope`、`@#hash` 等
- 子文件扩展名必须在白名单（约 80 种文本/代码扩展名；触发跳过会发 `tengu_claude_md_include_skipped_extension` 埋点）
- 块级 HTML 注释 `<!-- ... -->`（独占一行）从加载内容里剥掉
- 循环引用安全（visited 集合保护）
- 深度上限 5 层
- 文件不存在静默忽略（不抛错）；EACCES 触发 `tengu_claude_md_permission_error` 埋点

---

## 7. 端到端验证脚本（可复制粘贴）

下面所有脚本基于本仓库的 mock server，无需真实 API key。

### 7.1 验证自动 compact

```bash
# 终端 1
bun run mock

# 终端 2
NOVA_API_KEY=anything \
NOVA_TRANSPORT=mock \
NOVA_MOCK_SCENARIO=chat \
NOVA_MOCK_INFLATE_USAGE=168000 \
bun run start chat
> hello
ok
> world
[compact] auto-compacting (≈ 168000 tokens)
[compact] done: 168000 → ... tokens
ok
> /exit
```

### 7.2 验证 /compact 手动

```bash
NOVA_API_KEY=anything \
NOVA_TRANSPORT=mock \
NOVA_MOCK_SCENARIO=chat \
bun run start chat
> q1
ok
> q2
ok
> /compact focus on test files
已压缩 4 条消息 → 1 条 summary (≈ ... → ... tokens)
> /exit
```

### 7.3 验证 CLAUDE.md 注入

```bash
mkdir -p ~/.nova-code
cat > ~/.nova-code/CLAUDE.md <<'EOF'
USER_LEVEL_RULE: Always reply in lower-case.
@./extra.md
EOF
cat > ~/.nova-code/extra.md <<'EOF'
INCLUDED_RULE: keep responses ≤ 5 words.
EOF

NOVA_API_KEY=anything \
NOVA_TRANSPORT=mock \
NOVA_MOCK_SCENARIO=chat \
bun run start chat --debug
# debug 日志（chat-llm-*.log）的 system 字段应同时包含 USER_LEVEL_RULE 与 INCLUDED_RULE
```

### 7.4 e2e 测试套件

```bash
bun test src/m4-e2e-compact.test.ts
# 期望：4 条全绿（自动 compact / /compact 手动 / 50 轮不超限 / CLAUDE.md 注入）
```

---

## 8. 提交前校验矩阵

```bash
bun run typecheck   # tsc --noEmit
bun test            # 全量 *.test.ts（含 m4-e2e-compact）
bun run check       # biome lint + format
```

任一失败按 CLAUDE.md §6 零容忍原则当场修复。

---

## 9. 故障排查

| 现象 | 可能原因 | 解决 |
|---|---|---|
| `[compact] failed: ...` 反复出现 | LLM 拒绝压缩、API 限流 | 看 `~/.nova-code/logs/chat-llm-*.log` 找 compact_error；若是限流可手动 `/compact` 隔几分钟再试 |
| 自动 compact 不触发，对话还是超长 | 模型 usage 没正确返回 / mock 没设 NOVA_MOCK_INFLATE_USAGE | 跑 `--debug`，看 chat-llm 日志的 `usage.input_tokens` |
| `/compact` 立即报 "No messages to compact yet." | 当前会话 messages 为空 | 先发一两轮对话再 /compact |
| CLAUDE.md 改了但模型没遵守 | 启动时已加载，运行时改不会重新读 | `/exit` 后重新启 chat |
| @include 的子文件没加载 | 路径不在白名单扩展名 / 在 fenced code block 或 inline code 内 / 循环引用 | 检查扩展名是否在 `.md/.txt/.json/...` 等文本类型；fenced/inline code 内的 `@path` 不会触发；用 `NOVA_TELEMETRY_FILE` 看 `tengu_claude_md_include_skipped_extension` 事件可定位 |
| Windows 上 `/etc/nova-code/CLAUDE.md` 不生效 | M4 在 Windows 上跳过 managed 层 | 改用 user 层 `~/.nova-code/CLAUDE.md` |
| 想看埋点事件 | 默认仅写环形 buffer | 设 `NOVA_TELEMETRY_FILE=$HOME/.nova-code/logs/events.jsonl` 启动 chat / ask；或 `NOVA_DISABLE_TELEMETRY=1` 完全关闭 |

---

## 10. 跨文档引用

- 设计决策：[`docs/design/M4-compact.md`](../design/M4-compact.md)
- 实现架构：[`docs/architecture/M4/README.md`](../architecture/M4/README.md)
- 上游 milestone 手册：
  - [M3 权限](./M3-usage-guide.md)
  - [M2 chat REPL](./M2-usage-guide.md)
- 路线图：[`docs/roadmap.md`](../roadmap.md)
