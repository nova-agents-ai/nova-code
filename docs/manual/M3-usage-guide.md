# nova-code M3 使用手册

> 适用范围：M3 阶段（权限与安全）。覆盖 M0~M2 的全部能力之上，新增**工具调用前的确认机制**、**三层规则持久化**、**四档权限模式切换**，以及 `--dangerously-skip-permissions` 逃生舱。
>
> 本手册面向**终端用户**与**代码审阅者**，目标是：读完即可独立完成从配置规则、感受弹窗、切换权限模式到持久化 allowlist 的完整验证。
>
> 上游设计请参见 [docs/design/M3-permissions.md](../design/M3-permissions.md)；实现架构请参见 [docs/architecture/M3/README.md](../architecture/M3/README.md)；基础能力（`ask` / `chat` / debug / 会话持久化）请先阅读 [M2-usage-guide.md](./M2-usage-guide.md)。

---

## 目录

1. [M3 带来了什么](#1-m3-带来了什么)
2. [四档权限模式](#2-四档权限模式)
3. [七步决策流水线](#3-七步决策流水线)
4. [三层规则存储](#4-三层规则存储)
5. [REPL 5 档交互弹窗](#5-repl-5-档交互弹窗)
6. [`/permissions` 斜杠命令](#6-permissions-斜杠命令)
7. [`--dangerously-skip-permissions` 逃生舱](#7---dangerously-skip-permissions-逃生舱)
8. [ask 下的 headless 行为](#8-ask-下的-headless-行为)
9. [规则文件手工编辑](#9-规则文件手工编辑)
10. [端到端完整验证示例](#10-端到端完整验证示例)
11. [故障排查](#11-故障排查)

---

## 1. M3 带来了什么

在 M2 之前，`ask` / `chat` 里 LLM 一旦决定调用 `Bash` / `FileWrite` / `FileEdit`，工具就直接执行，用户**完全没有拦截机会**。M3 填补这道护栏：

| 能力 | 说明 |
|------|------|
| 内置高危命令黑名单 | `sudo`、`rm -rf /`、`curl \| sh`、`mkfs`、fork bomb 等，**任何模式都拦** |
| 默认调用前询问 | chat 默认模式下，`Bash` / `FileWrite` / `FileEdit` 调用前弹出 5 档菜单 |
| 规则持久化 | 用户选 "allow always" 后，规则写入 session / project / global 任一层 |
| `/permissions` 斜杠命令 | REPL 内查看全部规则、切换当前权限模式 |
| `--dangerously-skip-permissions` | 逃生舱 flag：跳过所有询问（但黑名单仍拦） |
| headless auto-deny | `ask` 命令默认 `acceptEdits` 模式下，Bash 被问到时自动 deny 并在 stderr 留审计 |

---

## 2. 四档权限模式

| Mode | chat 行为 | ask 行为 | 适用场景 |
|------|-----------|----------|----------|
| `default` | **chat 默认**。严格走七步流水线，`Bash/FileWrite/FileEdit` 弹 5 档菜单 | — | 人机交互 |
| `acceptEdits` | — | **ask 默认**。`FileWrite/FileEdit` 自动放行；Bash 仍走询问 → headless auto-deny | 让 ask 生成代码文件 |
| `bypassPermissions` | 所有询问被跳过直接 allow（黑名单仍拦） | 同左 | `--dangerously-skip-permissions` |
| `plan` | 目前与 `default` 等价 | 同左 | M11 AgentTool 预留 |

chat REPL 里可用 `/permissions mode <m>` 运行时切换；ask 没有内置切换途径，只能通过 flag 决定启动模式。

---

## 3. 七步决策流水线

每次 LLM 产生 `tool_use` 时，QueryEngine 串行对每一项过以下流水线，**第一个命中者决定结果**：

```
1. DENY_PATTERNS(Bash)      —— 内置高危命令黑名单，任何模式下都拦截
2. bypassPermissions 模式    —— 直接 allow（DENY_PATTERNS 已先拦）
3. 规则 match → deny         —— 显式 deny 规则胜
4. 规则 match → allow/ask    —— 显式 allow / 询问
5. acceptEdits 模式          —— File 写工具直接 allow
6. tool.requiresApproval     —— 工具自身声明需要询问
7. 默认 allow                —— 都没命中即放行
```

第 3、4 步的规则 match 顺序：`session > project > global`。第 1 步的 DENY_PATTERNS 与第 7 步的默认值是**硬编码底线**，不受规则系统影响。

### 3.1 DENY_PATTERNS 完整清单（M3 版）

| 名称 | 正则 | 典型场景 |
|------|------|----------|
| `rm-rf-root` | `\brm\s+(-[rRfF]+\s+)+\/(\s\|$)` | `rm -rf /` |
| `rm-rf-root-glob` | `\brm\s+(-[rRfF]+\s+)+\/\*` | `rm -rf /*` |
| `rm-rf-home` | `\brm\s+(-[rRfF]+\s+)+~(\/\|\s\|$)` | `rm -rf ~` |
| `dd-to-disk` | `\bdd\s+.*\bof=\/dev\/(sd\|nvme\|disk)` | `dd if=... of=/dev/sda` |
| `mkfs` | `\bmkfs\b` | 格式化磁盘 |
| `redirect-to-disk` | `>\s*\/dev\/sd[a-z]` | 直写块设备 |
| `fork-bomb` | `:\(\)\{\s*:\|:&\s*\};:` | shell fork bomb |
| `curl-pipe-shell` | `\b(curl\|wget)\s+[^\|]*\|\s*(sh\|bash\|zsh)\b` | `curl http://x.sh \| sh` |
| `sudo` | `\bsudo\b` | 提权 |

> **注意**：`sudo` 在 claude-code 是 soft warn，nova-code 把它升级为硬拦截。如需在容器里真的用 sudo，必须显式走 `bypassPermissions`；但哪怕 bypass，`DENY_PATTERNS` 依然会在流水线第 1 步拦下。

---

## 4. 三层规则存储

规则以 `PermissionRule = { toolName, ruleContent?, behavior: "allow" | "deny" }` 为单位，分三层：

| 层级 | 存储位置 | 生命周期 |
|------|----------|----------|
| `session` | 进程内存 | REPL 进程退出即消失 |
| `project` | `<cwd>/.nova-code/permissions.json` | 建议纳入 git |
| `global` | `~/.nova-code/permissions.json` | 跨项目持久 |

### 4.1 文件 schema

```json
{
  "version": 1,
  "rules": [
    { "toolName": "Bash", "ruleContent": "git:*", "behavior": "allow" },
    { "toolName": "Bash", "ruleContent": "npm:install", "behavior": "allow" },
    { "toolName": "FileWrite", "ruleContent": "/Users/alice/repo/README.md", "behavior": "allow" },
    { "toolName": "Bash", "ruleContent": "rm", "behavior": "deny" }
  ]
}
```

### 4.2 ruleContent 语法（M3 最小集）

| 工具 | 语法 | 语义 |
|------|------|------|
| `Bash` | `"<cmd>:*"` | 命令名匹配：以 `<cmd> ` 开头的所有命令（如 `git:*` 匹配 `git push` / `git status`） |
| `Bash` | `"<cmd>:<sub>"` | 命令名 + 子命令精确匹配（如 `npm:install`） |
| `Bash` | `"*"` 或省略 | 匹配该工具所有调用 |
| `FileWrite` / `FileEdit` | `"/abs/path"` | **绝对路径**精确匹配（目录通配 `**` 暂不支持，M4/M7 再做） |
| 其它工具 | 省略 `ruleContent` | 匹配该工具所有调用 |

### 4.3 去重键与覆盖语义

去重键 = `toolName + "\t" + ruleContent`。同键的规则，**后加入覆盖先加入**（"最新决策胜出"）。合并优先级 `session > project > global`：session 里对同一键的决策会盖掉 project / global。

---

## 5. REPL 5 档交互弹窗

chat 默认模式下，任何需要询问的调用会在 stderr 打印以下菜单：

```
[permission] Bash `git push origin main` — tool requires approval
  1) allow once
  2) allow always (session)
  3) allow always (project)
  4) allow always (global)
  5) deny
  选择 1-5（回车=5 deny）:
```

按键语义：

| 输入 | 决策 | 持久化 |
|------|------|--------|
| `1` | allow 本次 | — |
| `2` | allow 本次 + 写 session | 进程内存 |
| `3` | allow 本次 + 写 project | `<cwd>/.nova-code/permissions.json` |
| `4` | allow 本次 + 写 global | `~/.nova-code/permissions.json` |
| `5` 或 回车 或 非法输入 | deny（本次 tool_result 带 `is_error`） | — |
| `Ctrl+D` / EOF | deny | — |

**安全从严原则**：空行、无效输入、EOF 一律 deny，不会误放行。

---

## 6. `/permissions` 斜杠命令

仅在 chat REPL 中可用。

### 6.1 列出规则

```text
> /permissions
[session] (2)
  allow Bash git:*
  allow Bash npm:install
[project] (1)
  allow FileWrite /Users/alice/repo/README.md
[global] (0)
  (none)
```

或显式子命令：`/permissions list`（等价默认）。

### 6.2 查看 / 切换模式

```text
> /permissions mode
当前模式：default

> /permissions mode acceptEdits
权限模式：default → acceptEdits

> /permissions mode nonsense
未知模式 "nonsense"。合法值：default | acceptEdits | bypassPermissions | plan
```

### 6.3 规则增删

**不提供 `/permissions add` / `/permissions remove`**。增规则通过 5 档菜单的 2/3/4 选项完成；删规则需手工编辑 `.nova-code/permissions.json` 文件（见 §9）。这样避免用户因 ruleContent 语法错误自伤。

---

## 7. `--dangerously-skip-permissions` 逃生舱

```bash
# chat：启动即进入 bypassPermissions 模式（DENY_PATTERNS 仍拦）
bun run start -- chat --dangerously-skip-permissions

# ask：一次性命令里生效
bun run start -- ask --dangerously-skip-permissions "帮我把 src/foo.ts 里所有 any 改成 unknown"
```

适用场景：CI / 容器里跑 nova-code，事先已知命令可信，不想被交互菜单打断。

> ⚠️ **不要**把 `--dangerously-skip-permissions` 写进 `alias` / 脚本默认参数。逃生舱应该是临时的、显式的。

即便 bypass，这几类命令仍会被拦：

- DENY_PATTERNS（§3.1）全部
- session/project/global 里显式写了 `behavior: "deny"` 的规则（因为流水线第 3 步在第 2 步之前）

---

## 8. ask 下的 headless 行为

`ask` 是一次性命令，**没有真人在终端等弹窗**。因此采用 headless Provider：

- 默认模式：`acceptEdits`
  - `FileWrite` / `FileEdit` → 自动放行
  - `Bash` → 走到询问阶段时 auto-deny，并在 stderr 留一条审计：

    ```
    [permission] headless mode auto-deny: Bash (tool requires approval)
    ```

- `--dangerously-skip-permissions`：切到 `bypassPermissions`，等价于"所有工具都允许（DENY_PATTERNS 除外）"

实战建议：

- 只想让 ask 读文件 / 写文件：直接跑，不加 flag
- 需要 ask 跑 `bun test` / `git status` 等命令：加 `--dangerously-skip-permissions`，并确认命令来源可信

---

## 9. 规则文件手工编辑

规则文件是纯 JSON，可以用任意编辑器维护。示例：在 `<cwd>/.nova-code/permissions.json` 里预置一套"项目常用放行清单"：

```json
{
  "version": 1,
  "rules": [
    { "toolName": "Bash", "ruleContent": "git:*", "behavior": "allow" },
    { "toolName": "Bash", "ruleContent": "bun:test", "behavior": "allow" },
    { "toolName": "Bash", "ruleContent": "bun:run", "behavior": "allow" },
    { "toolName": "FileEdit", "ruleContent": "*", "behavior": "allow" }
  ]
}
```

提交到 git 后，团队成员在该项目下跑 chat 就共享这份清单。

**校验行为**：

- 文件不存在 → 视为空规则（非错误）
- JSON 损坏 / 字段不合法 → `chat` / `ask` 启动即失败，退出码 1，stderr 打印 `Permissions file at <path> is not valid JSON: ...` 或字段错误定位
- `version` 必须为 `1`

---

## 10. 端到端完整验证示例

下面是一份可以从上到下**复制粘贴**的验证脚本，逐一覆盖 M3 DoD。

### 10.1 前置

```bash
cd /path/to/nova-code
export NOVA_API_KEY="sk-ant-xxxxxxxxxxxx"
bun install
bun run start -- --version    # 应该输出 nova-code v1.0.0
```

### 10.2 Scene A：默认模式下被询问

```text
$ bun run start -- chat
nova-code chat（session: 20260504-130000-ab12cd, model: claude-sonnet-4-5-20250929）
输入 /help 查看命令；Ctrl+C 取消当前请求、双按退出；Ctrl+D 直接退出。

> 帮我在当前目录跑一下 `git status`

[permission] Bash `git status` — tool requires approval
  1) allow once
  2) allow always (session)
  3) allow always (project)
  4) allow always (global)
  5) deny
  选择 1-5（回车=5 deny）: 2

...（工具继续执行，LLM 根据结果给出总结）...

> 再跑一次 git status
...（这次**不再弹**，因为 session 里已经有 Bash/git:* 的 allow）...

> /permissions
[session] (1)
  allow Bash git:*
[project] (0)
  (none)
[global] (0)
  (none)

> /exit
```

验证点：
- 第一次弹窗，选 2（session）后第二次不再问
- `/permissions` 确实看到刚加的规则

### 10.3 Scene B：DENY_PATTERNS 硬拦截

```text
$ bun run start -- chat --dangerously-skip-permissions
nova-code chat（session: ..., model: ...）
...

> 帮我跑 `sudo ls /root`
[permission_decision] Bash denied by DENY_PATTERNS: sudo
（LLM 收到 is_error 的 tool_result，通常会调整思路或直接说明无法执行）

> /exit
```

验证点：即使带了 `--dangerously-skip-permissions`，`sudo` 仍被拦，证明黑名单不受模式影响。

### 10.4 Scene C：在 REPL 中切换模式

```text
$ bun run start -- chat
...

> /permissions mode
当前模式：default

> /permissions mode acceptEdits
权限模式：default → acceptEdits

> 帮我在 /tmp/nova-m3-test.txt 里写一行 "hi from nova"
...（FileWrite 这次不再弹窗，直接执行）...

> /permissions mode default
权限模式：acceptEdits → default

> /exit
```

验证点：
- 切到 `acceptEdits` 后 `FileWrite` 无需询问
- 切回 `default` 恢复严格模式

### 10.5 Scene D：project 规则文件预置

```bash
# 1) 写一份项目规则
mkdir -p .nova-code
cat > .nova-code/permissions.json <<'EOF'
{
  "version": 1,
  "rules": [
    { "toolName": "Bash", "ruleContent": "bun:test", "behavior": "allow" }
  ]
}
EOF

# 2) 启动 chat，让模型跑测试
bun run start -- chat
```

```text
> 帮我跑一下 `bun test`
...（无弹窗，直接执行）...

> /permissions
[session] (0)
  (none)
[project] (1)
  allow Bash bun:test
[global] (0)
  (none)

> /exit
```

### 10.6 Scene E：ask 默认 acceptEdits + headless auto-deny

```bash
# 写文件型：放行
bun run start -- ask "帮我在 /tmp/nova-m3-ask.txt 里写一行 'from ask'"
# → 文件被写入，命令返回

# 命令型：在 headless 下被 auto-deny
bun run start -- ask "帮我跑 git status 并总结有哪些改动"
# stderr 会看到：
# [permission] headless mode auto-deny: Bash (tool requires approval)
# LLM 拿不到命令结果，一般会直接告诉你它无法执行该命令
```

再加 `--dangerously-skip-permissions` 重试：

```bash
bun run start -- ask --dangerously-skip-permissions "帮我跑 git status 并总结"
# → Bash 直接放行，模型拿到真实输出后给出总结
```

---

## 11. 故障排查

| 现象 | 原因 & 解决 |
|------|-------------|
| chat 启动即退出 1，stderr `Permissions file at .../.nova-code/permissions.json is not valid JSON: ...` | 规则文件 JSON 语法错误。用 `cat .nova-code/permissions.json \| jq .` 定位语法 |
| chat 启动即退出 1，提示 `invalid rule ...` | 规则字段校验失败（如 `behavior` 不是 `allow/deny`、`toolName` 为空）。按 §4.2 修正 |
| 按 1~4 后**仍然**被再次询问 | `ruleContent` 语法未命中你真正输入的命令。例如规则写 `"git"` 而非 `"git:*"`，只匹配纯 `git` 无参数调用 |
| `/permissions` 显示"权限系统未启用" | 进入 REPL 时 `PermissionStore.load` 没成功注入。检查当前 chat 是否为 M3 及之后版本，以及 `.nova-code/permissions.json` 是否存在读失败 |
| `sudo` 命令总是被拦 | 这是设计内的 DENY_PATTERNS 行为，见 §3.1。如必须执行，请脱离 nova-code 在 shell 里直接跑 |
| 想删一条规则 | 手工编辑 `~/.nova-code/permissions.json` 或 `<cwd>/.nova-code/permissions.json`，删掉对应数组项保存即可（M3 不提供 `/permissions remove`） |
| 写进 project 文件的规则没生效 | 确认启动 chat 时的 `cwd` 和规则文件所在目录一致；`cd` 错目录会读不到 |
| `acceptEdits` 下 Bash 还是被拦 | 这是对的。`acceptEdits` 只放行 `FileWrite/FileEdit`，Bash 仍走询问或 headless auto-deny。需要 Bash 放行请加 `bypassPermissions` 或手工加 Bash 规则 |

---

## 12. 提交前校验矩阵

跟 M2 一致的三件套（M3 阶段测试总数已到 **496 pass / 0 fail**）：

```bash
bun run typecheck && bun run check && bun test
```

只跑 M3 相关：

```bash
bun test src/services/permissions/                   # 权限引擎 & 规则存储
bun test src/commands/ChatCommand/slash/permissions  # /permissions 斜杠命令
bun test src/commands/ChatCommand/replPermissionProvider    # REPL 5 档菜单
bun test src/commands/AskCommand/headlessPermissionProvider # headless auto-deny
```

---

*手册对应 M3 阶段（权限与安全）。设计决策详见 [docs/design/M3-permissions.md](../design/M3-permissions.md)；实现架构详见 [docs/architecture/M3/README.md](../architecture/M3/README.md)；roadmap 见 [docs/roadmap.md](../roadmap.md)；基础能力手册见 [docs/manual/M2-usage-guide.md](./M2-usage-guide.md)。*
