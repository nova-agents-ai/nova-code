# nova-code M2 使用手册

> 适用范围：M2 阶段（多轮 Chat REPL + 会话持久化）。覆盖 M0 CLI 骨架、M1 工具集、M1.5 `llm` 命名空间重构，以及 M2 新增的 `chat` 子命令。
>
> 本手册面向**终端用户**与**代码审阅者**，目标是：读完即可独立完成从环境准备、API Key 配置、单轮问答到多轮对话 + 会话持久化的完整功能验证。

---

## 目录

1. [前置与安装](#1-前置与安装)
2. [配置 API Key](#2-配置-api-key)
3. [命令总览](#3-命令总览)
4. [hello / echo — 最小烟测](#4-hello--echo--最小烟测)
5. [ask — 单轮问答（含工具调用）](#5-ask--单轮问答含工具调用)
6. [chat — 多轮 REPL（M2 核心）](#6-chat--多轮-replm2-核心)
7. [会话持久化文件格式](#7-会话持久化文件格式)
8. [内置工具清单](#8-内置工具清单)
9. [端到端完整验证示例](#9-端到端完整验证示例)
10. [提交前校验矩阵](#10-提交前校验矩阵)
11. [故障排查](#11-故障排查)

---

## 1. 前置与安装

- **Bun** `>= 1.3.0`（M2 代码使用了 `node:readline/promises` 的 async iterator，以及 `Bun.stdin.stream()`）。
- 一个可用的 **Anthropic API Key**（以 `sk-ant-` 开头）或任何兼容 Anthropic Messages API 的网关密钥。

```bash
# 1. 克隆并安装依赖
git clone https://github.com/dinglevin/nova-code.git
cd nova-code
bun install

# 2. 冒烟：不配 API Key 也能跑的命令
bun run start -- --help
bun run start -- hello world
```

上面 `bun run start -- <args>` 等价于 `bun run bin/nova-code.ts <args>`。本手册后续示例统一写作 `nova-code <args>`，如未 `bun link` 到 PATH，请替换为 `bun run start --`。

---

## 2. 配置 API Key

nova-code 支持两种配置来源，**环境变量优先级高于配置文件**：

### 2.1 环境变量（推荐给 CI / 容器）

| 变量 | 作用 | 必填 |
|------|------|------|
| `NOVA_API_KEY` | Anthropic API Key | ✅ |
| `NOVA_BASE_URL` | 自定义网关 URL（可选） | ❌ |
| `NOVA_MODEL` | 覆盖默认模型 | ❌ |

```bash
export NOVA_API_KEY="sk-ant-xxxxxxxxxxxx"
# 可选
export NOVA_BASE_URL="https://your-gateway.example.com"
export NOVA_MODEL="claude-sonnet-4-5-20250929"
```

### 2.2 配置文件（推荐给本地开发）

路径：`~/.nova-code/config.json`

```json
{
  "apiKey": "sk-ant-xxxxxxxxxxxx",
  "baseURL": "https://your-gateway.example.com",
  "model": "claude-sonnet-4-5-20250929",
  "maxTokens": 8192,
  "maxTurns": 25
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `apiKey` | string | — | LLM API Key（环境变量 `NOVA_API_KEY` 未设置时必填） |
| `baseURL` | string | — | 自定义 base URL（SDK 默认走官方 endpoint） |
| `model` | string | `claude-sonnet-4-5-20250929` | 模型名 |
| `maxTokens` | int > 0 | `8192` | 单次响应最大 token 数 |
| `maxTurns` | int > 0 | `25` | 单轮 agent loop 最大迭代次数（防工具循环烧 token） |

> 优先级：`env > config.json > 内置默认值`。`apiKey` 两处都没有时，`ask` / `chat` 会打印 `LLM API key not configured...` 并以退出码 1 结束。

---

## 3. 命令总览

```bash
nova-code                      # 等价于 --help
nova-code --help               # 打印帮助
nova-code --version            # 打印 nova-code v1.0.0
nova-code hello [name]         # 打招呼，默认 world
nova-code echo <text...>       # 回显参数
nova-code ask [question]       # 单轮 LLM 问答（支持 stdin 管道）
nova-code chat                 # 进入多轮 REPL（M2 新增）
```

子命令独立 flag：

| 命令 | 支持的 flag |
|------|-------------|
| `ask` | `--debug`、`--debug-pretty` |
| `chat` | `--debug`、`--debug-pretty`、`--resume <id\|alias>` |

- `--debug`：把完整 AgentEvent 流写入 `~/.nova-code/logs/<prefix>-<timestamp>-<sessionId>.log`（不污染 stderr）。
- `--debug-pretty`：隐含开启 `--debug`；日志改用多行缩进 JSON，并把字符串中的 `\n` 还原为真实换行，便于肉眼阅读。
- `--resume`：仅 `chat` 有；从 `~/.nova-code/sessions/<idOrAlias>.jsonl` 恢复历史。

---

## 4. hello / echo — 最小烟测

这两个命令完全离线，用来验证 CLI 分发骨架与安装是否正常。

```bash
$ nova-code hello
Hello, world!

$ nova-code hello alice
Hello, alice!

$ nova-code echo it works
it works

$ nova-code unknown-cmd
未知命令: unknown-cmd
运行 `nova-code --help` 查看可用命令。
# 退出码 1
```

---

## 5. ask — 单轮问答（含工具调用）

`ask` 读入一条问题，让 LLM 驱动 agent loop（可多轮调用本地工具），最终把回答打到 stdout，进程退出。

### 5.1 三种提问方式

```bash
# a) 参数传入
nova-code ask "当前项目里 src 目录的 ts 文件有几个？"

# b) 管道传入
echo "列出当前目录下以 .md 结尾的文件" | nova-code ask

# c) 交互式：什么都不传，会打印 "Your question: " 提示符
nova-code ask
```

### 5.2 debug 模式

```bash
nova-code ask --debug "帮我读一下 README.md 开头 20 行"
# stderr 会提示：
# [debug] log file: /Users/<you>/.nova-code/logs/ask-<ts>-<sessionId>.log

nova-code ask --debug-pretty "帮我读一下 README.md 开头 20 行"
# stderr 追加：
# [debug] pretty mode: on
```

打开对应日志文件，可以看到完整的 AgentEvent 流（`session_start` / `assistant_text` / `tool_use` / `tool_result` / `turn_end` 等），便于排查 LLM 为什么选择某个工具、工具返回了什么。

### 5.3 退出码

| 情况 | 退出码 |
|------|--------|
| 正常完成 | `0` |
| 未提供问题（交互式读入空行 / EOF） | `1` |
| 其他运行时错误（API key 未配置、网络异常等） | 非 0（由顶层 `runCli` 兜底） |

---

## 6. chat — 多轮 REPL（M2 核心）

### 6.1 基本流程

```bash
$ nova-code chat
nova-code chat（session: 20260504-120030-ab12cd, model: claude-sonnet-4-5-20250929）
输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。

> 你好，我叫 levin。
你好 levin！很高兴见到你，我能帮你做什么？
> 记得我的名字吗？
当然，levin。……
> /exit
```

关键点：
- 启动时**不**写盘。`sessionId` 在会话初次 `/save` 之前都只存在于内存。
- 空行不会产生任何动作（既不发给模型，也不清 Ctrl+C 窗口）。
- `Ctrl+D` / stdin EOF → 正常退出（码 0）。

### 6.2 斜杠命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `/help` | `/help` | 列出所有斜杠命令及 description |
| `/clear` | `/clear` | 清空当前会话历史（**保留 sessionId / model / createdAt**） |
| `/save` | `/save [alias]` | 覆盖写 `<sessionId>.jsonl`；传 `alias` 则**额外**再写一份 `<alias>.jsonl` 副本 |
| `/load` | `/load <idOrAlias>` | 从 JSONL 恢复会话。当前会话非空时会弹 `y/n` 二次确认防误覆盖 |
| `/exit` | `/exit` | 退出 REPL，退出码 0 |

> 文件名安全策略：`id/alias` 不允许包含 `/`、`\`、`..`，也不允许以 `.` 开头；否则 `/save`、`/load` 会报错终止本次命令，**不影响**主 REPL 循环。

### 6.3 Ctrl+C 状态机

| 当前阶段 | Ctrl+C 行为 |
|----------|-------------|
| `idle`（等待输入） | 提示 `(再按一次 Ctrl+C 在 1.5 秒内退出；或继续输入。)` 并进入 `pending-exit` 窗口 |
| `pending-exit`（1.5s 窗口内） | 立即退出，退出码 `130` |
| `streaming`（正在跑 agent loop） | 中断当前请求（抛 `AbortError`），打印 `[cancelled]`，REPL 继续，不退出 |

任意在 `pending-exit` 窗口内**输入非空字符**都会取消退出意图回到 `idle`。

### 6.4 `--resume` 恢复会话

```bash
# 假设上一轮在会话里做过 /save my-plan
nova-code chat --resume my-plan
# 或直接用原始 sessionId
nova-code chat --resume 20260504-120030-ab12cd
```

- `--resume` 缺参数 → 打印 `chat: --resume requires <id|alias>` 并退出码 1。
- 找不到文件 → 打印 `chat: 加载会话失败：ENOENT ...` 并退出码 1。
- 成功加载后，欢迎横幅里的 `session` 就是恢复出来的 ID，历史消息作为 agent loop 的上下文继续使用。

### 6.5 debug 行为

```bash
nova-code chat --debug
# stderr：
# [debug] log file: /Users/<you>/.nova-code/logs/chat-<ts>-<sessionId>.log
```

`chat` 下的日志前缀固定为 `chat`，后缀使用**当前 session 的 sessionId**。即便中途 `/load` 切换到另一份会话，日志文件仍是启动时的那一份——这样便于按进程回溯。

---

## 7. 会话持久化文件格式

文件路径：`~/.nova-code/sessions/<idOrAlias>.jsonl`

格式：**每行一个 JSON 对象**，首行 `meta`，其余均为 `msg`。

```jsonl
{"kind":"meta","sessionId":"20260504-120030-ab12cd","model":"claude-sonnet-4-5-20250929","createdAt":"2026-05-04T12:00:30.123Z"}
{"kind":"msg","role":"user","content":"你好，我叫 levin。"}
{"kind":"msg","role":"assistant","content":[{"type":"text","text":"你好 levin！..."}]}
{"kind":"msg","role":"user","content":"列出 README.md 前 20 行"}
{"kind":"msg","role":"assistant","content":[{"type":"tool_use","id":"toolu_01...","name":"FileRead","input":{"path":"README.md","limit":20}},{"type":"text","text":"..."}]}
```

约束：
- **首条非空行**必须是 `{"kind":"meta",...}`，否则 `/load` / `--resume` 会抛 `Expected first non-empty line to be meta...`。
- `meta` 行必须提供 `sessionId`、`model`、`createdAt` 三个非空字符串字段。
- `msg.role` 只能是 `"user"` 或 `"assistant"`；`content` 可以是字符串或数组（数组元素对应 Anthropic content block）。
- 空行会被忽略（方便手工 `vim` 编辑后保留空白）。
- `/save` 语义是**覆盖写整份快照**，不是 append。M2 先做最稳的形态。

手动查看：

```bash
# 列出所有会话
ls -lh ~/.nova-code/sessions/

# 查看内容（每行一条）
cat ~/.nova-code/sessions/my-plan.jsonl | head

# 用 jq 格式化
jq -c . ~/.nova-code/sessions/my-plan.jsonl
```

---

## 8. 内置工具清单

`ask` 与 `chat` 共享一套内置工具（M1 交付）。LLM 根据问题自动决定是否调用，用户不必显式触发。

| 工具名 | 作用 |
|--------|------|
| `LS` | 列出目录内容 |
| `FileRead` | 读取文本文件（支持 offset / limit / 行号） |
| `FileWrite` | 覆盖写文件 |
| `FileEdit` | 定位字符串并替换（支持 `replace_all`） |
| `Bash` | 执行 shell 命令（内置软告警名单，如 `sudo`、`curl`） |
| `Grep` | 基于 ripgrep（缺失时自动回退 JS 实现）的内容搜索 |
| `Glob` | 按 glob 模式匹配文件 |

工具运行时的截断/超时/安全策略详见 [docs/design/M1-tools.md](../design/M1-tools.md)。

---

## 9. 端到端完整验证示例

下面是一个**可复制粘贴**的完整验证脚本，覆盖 M2 DoD 要点：
*多轮对话不丢上下文 → `/save alias` → `/exit` → `--resume` 继续 → `/load` 切换会话。*

### 9.1 准备

```bash
cd /path/to/nova-code
export NOVA_API_KEY="sk-ant-xxxxxxxxxxxx"
bun install
bun run start -- --version        # 应该输出 nova-code v1.0.0
```

### 9.2 Scene A：新建会话 → 多轮 → /save alias → /exit

```text
$ bun run start -- chat --debug
[debug] log file: /Users/levin/.nova-code/logs/chat-2026-05-04T120030-xxx.log
nova-code chat（session: 20260504-120030-ab12cd, model: claude-sonnet-4-5-20250929）
输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。

> 我在写一个 TODO list 应用，先记住我打算用 React + Vite。
好的，已记下：React + Vite 的 TODO 应用。需要我帮你从哪里开始？

> 按我们刚才的方案，起一个最小目录结构建议。
建议的目录结构：
  src/
    components/
    hooks/
    App.tsx
    main.tsx
  ...

> /save my-todo-plan
已保存到 /Users/levin/.nova-code/sessions/20260504-120030-ab12cd.jsonl
别名副本：/Users/levin/.nova-code/sessions/my-todo-plan.jsonl

> /exit
```

验证点：
- 第二轮回答必须能识别"刚才的方案" = React + Vite（上下文保留）。
- `/save my-todo-plan` 同时写两份文件，**主文件用原始 sessionId**。

### 9.3 Scene B：`--resume` 恢复继续对话

```text
$ bun run start -- chat --resume my-todo-plan
nova-code chat（session: 20260504-120030-ab12cd, model: claude-sonnet-4-5-20250929）
输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。

> 我们刚才讨论的是什么项目？用哪个框架？
你在做一个 TODO list 应用，前端选择了 React + Vite。

> /exit
```

验证点：
- 欢迎横幅里的 `sessionId` 与 9.2 中一致（别名和主 ID 指向同一份快照）。
- 模型必须能回忆起"TODO 应用 + React + Vite"，证明 JSONL 反序列化正确地把历史消息喂回 agent loop。

### 9.4 Scene C：同会话内 `/load` 切换到另一份历史

提前准备两份可加载的会话：先跑一次 9.2 产出 `my-todo-plan`，再跑一次新会话并 `/save other-plan`。然后：

```text
$ bun run start -- chat
nova-code chat（session: 20260504-121500-ef34gh, model: claude-sonnet-4-5-20250929）
输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。

> 这是一个全新的会话。
好的，请问有什么可以帮你的？

> /load my-todo-plan
当前会话将被替换，继续？(y/n) y
已加载会话 20260504-120030-ab12cd（4 条消息）。

> 现在记得我们的项目吗？
记得，是一个基于 React + Vite 的 TODO list 应用。

> /clear
已清空当前会话历史。

> 项目是什么？
（此处模型不应再“记得”之前的 TODO 项目；若还能回忆，说明 /clear 失败）

> /exit
```

验证点：
- `/load` 弹出的 `y/n` 确认框可中止切换。
- `/load` 成功后欢迎横幅的 `sessionId` 已经变成被加载会话的那个。
- `/clear` 清空消息后，模型不应再召回已清空的上下文。

### 9.5 Scene D：Ctrl+C 双按退出

```text
$ bun run start -- chat
nova-code chat（session: ..., model: ...）
输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。

> ^C
(再按一次 Ctrl+C 在 1.5 秒内退出；或继续输入。)
^C
# 进程立刻退出，echo $? 应为 130
```

### 9.6 Scene E：Ctrl+C 取消进行中的请求

```text
> 请给我写一份 50 页的设计文档并逐段输出
... 正在生成（流式文字陆续打到 stdout） ...
^C
[cancelled]

> /exit
```

验证点：取消后 REPL 不退出，仍能继续交互。

---

## 10. 提交前校验矩阵

按 `CLAUDE.md` 约定，**任何代码变更在提交前都必须通过以下三件套**（全部绿才算 DoD）：

```bash
bun run typecheck     # tsc --noEmit，应为 0 error
bun run check         # biome check，应为 0 error 0 warning
bun test              # bun:test，应当前全绿（截至 M2 为 310 pass / 0 fail）
```

一次性跑全：

```bash
bun run typecheck && bun run check && bun test
```

辅助脚本（M2 新增的 e2e）：

```bash
bun test src/m2-e2e-chat.test.ts    # 仅跑 chat REPL 子进程 e2e
bun test src/commands/ChatCommand/  # 仅跑 ChatCommand 相关单测
```

---

## 11. 故障排查

| 现象 | 原因 & 解决 |
|------|-------------|
| `chat: LLM API key not configured. Set the NOVA_API_KEY...` | 未设置 `NOVA_API_KEY` 环境变量，且 `~/.nova-code/config.json` 里没有 `apiKey`。按 §2 补齐即可 |
| `chat: --resume requires <id\|alias>` | `--resume` 后未跟参数 |
| `chat: 加载会话失败：ENOENT: no such file or directory, open ...` | `~/.nova-code/sessions/<id>.jsonl` 不存在；用 `ls ~/.nova-code/sessions/` 查可用文件名 |
| `chat: 加载会话失败：unsafe session id/alias: ...` | id/alias 带了 `/` `\` `..` 或以 `.` 开头——改名重试 |
| `/save 失败：...` / `/load 失败：...` | 这两个错误不会中断 REPL，只失败当前命令；按提示检查文件名或磁盘权限 |
| 运行后卡住无响应 | 若处于 `streaming`，按一次 `Ctrl+C` 中断即可；仍卡住可 `Ctrl+C Ctrl+C` 退出 |
| debug 日志在哪？ | `~/.nova-code/logs/`；文件名前缀 `ask-` 或 `chat-`，后缀是对应会话 ID |
| 想要人肉读 debug 日志 | 改用 `--debug-pretty`，或在产生 `.log` 后执行 `jq -c .` |
| ripgrep 未安装 | `Grep` 工具自动回退到 JS 实现；功能一致，性能略差 |

---

*手册对应 M2 阶段（`chat` 子命令 + 会话 JSONL 持久化）。设计决策详见 [docs/design/M2-chat-repl.md](../design/M2-chat-repl.md)；roadmap 见 [docs/roadmap.md](../roadmap.md)。*
