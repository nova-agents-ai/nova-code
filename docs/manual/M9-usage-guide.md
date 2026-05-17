# M9 使用手册 — Skills 系统

> 面向终端用户 / 新人上手。M9 支持从项目或用户目录加载 `SKILL.md`。运行时对齐 claude-code：先把 skill 名称/描述列表暴露给模型，模型判断相关后通过 `Skill` tool 加载完整正文。

---

## 1. 前置条件

- Bun >= 1.3；
- 已配置 `NOVA_API_KEY` 或使用 `NOVA_TRANSPORT=mock` 做本地验证；
- skill 文件放在以下任一目录的直接子目录下：
  - `<cwd>/.nova-code/skills/<name>/SKILL.md`
  - `~/.nova-code/skills/<name>/SKILL.md`
  - `~/.agents/skills/<name>/SKILL.md`

注意：M9 不递归扫描任意深度的 `**/SKILL.md`；`<name>` 必须是 skill root 的直接子目录名。

---

## 2. 创建一个 Skill

```bash
mkdir -p ~/.agents/skills/java
cat > ~/.agents/skills/java/SKILL.md <<'SKILL'
---
name: Java Display Name
description: Java JVM backend and concurrency review skill.
---
# Java Skill

When reviewing Java code:
- Check transaction boundaries and exception semantics.
- Check concurrency safety for shared mutable state.
- Prefer explicit resource ownership and lifecycle notes.
SKILL
```

canonical skill name 来自目录名，所以这里的调用名是 `java`。frontmatter `name` 可作为展示名保留，但不覆盖目录名。

manual-only skill 示例：

```md
---
description: MANUAL TRIGGER ONLY: invoke only when user types /gstack.
---
# GStack
...
```

M9 会把描述列给模型；是否只在 `/gstack` 时调用由描述约束模型行为。若需要严格对齐 claude-code、完全禁止模型看到并通过 `Skill` tool 调用该 skill，使用：

```md
---
description: Internal/manual only skill.
disable-model-invocation: true
---
```

---

设置后该 skill 仍可通过 `nova-code skill list/show` 查看，也仍可由用户直接输入 `/skill-name args` 显式调用；但它不会进入 ask/chat 的模型可见 listing，也不会注册为 `Skill` tool 可调用项。若需要禁止用户直接 slash 调用，额外设置 `user-invocable: false`。

---

## 3. 查看与调试

```bash
nova-code skill list
nova-code skill show java
```

`list` 输出示例：

```text
java    Java JVM backend and concurrency review skill.    /Users/me/.agents/skills/java/SKILL.md
```

`show` 会输出 skill 元数据、model/user invocable 状态、路径与完整正文，适合检查当前加载到的 `SKILL.md` 是否符合预期。M9 不再提供 `match` 子命令；普通语义选择由模型基于 listing 和 `Skill` tool 完成，`/name args` 则由本地 slash skill expansion 直接加载该 skill body。

---

## 4. 在 ask/chat 中使用

ask：

```bash
nova-code ask "review this Java concurrency service"
```

chat：

```bash
nova-code chat
> review this Java concurrency service
> /java review this service
```

行为说明：

- ask 每次加载 skill catalog，并把 model-invocable skill listing 加入 system prompt；
- chat 启动时加载 skill catalog，每轮复用同一 listing；
- system prompt 只包含 skill 名称/描述，不包含完整正文；
- 模型认为相关时调用 `Skill` tool，完整 `SKILL.md` body 才作为 tool result 返回；
- 用户直接输入 `/name args` 时，本地会直接加载对应 `SKILL.md` body，并把 `$ARGUMENTS` 替换为 args；
- skill 注入不改变工具权限，Bash/FileWrite/FileEdit 仍按 M3 权限系统走。

---

## 5. 环境变量

| 变量 | 作用 |
|---|---|
| `NOVA_DISABLE_SKILLS=1` | 禁用 skill 加载与注入 |
| `NOVA_SKILL_DIRS=/a,/b` | 覆盖默认 roots，多个目录用逗号分隔 |

示例：

```bash
NOVA_SKILL_DIRS="$PWD/demo-skills" nova-code skill list
```

`demo-skills` 下面仍然需要是 `<name>/SKILL.md` 结构。

---

## 6. 端到端可复制验证脚本

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"
mkdir -p "$TMP_HOME/.agents/skills/java"
cat > "$TMP_HOME/.agents/skills/java/SKILL.md" <<'SKILL'
---
description: Java JVM backend and concurrency review skill.
---
# Java Skill
M9_MANUAL_VERIFICATION_MARKER
SKILL

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" nova-code skill list
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" nova-code skill show java | grep M9_MANUAL_VERIFICATION_MARKER

LOG="$TMP_HOME/mock.jsonl"
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
  NOVA_API_KEY=sk-mock \
  NOVA_TRANSPORT=mock \
  NOVA_MOCK_SCENARIO=skill-loop \
  NOVA_MOCK_LOG_FILE="$LOG" \
  nova-code ask "review Java code"

# 第一轮 system prompt 只有 listing；第二轮 tool_result 才包含正文 marker
grep 'The following skills are available' "$LOG"
grep 'M9_MANUAL_VERIFICATION_MARKER' "$LOG"
rm -rf "$TMP_HOME"
```

---

## 7. 提交前校验矩阵

```bash
bun run typecheck
bun test
bun run check
```

M9 重点测试可单独运行：

```bash
bun test src/services/skills/skills.test.ts
bun test src/tools/SkillTool/SkillTool.test.ts
bun test src/commands/SkillCommand/SkillCommand.test.ts
bun test src/m9-e2e-skills.test.ts
```

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `No skills found.` | root 不对或文件不是 `<root>/<name>/SKILL.md` | 跑 `nova-code skill list`，确认目录层级 |
| 嵌套目录 skill 未加载 | M9 对齐 claude-code，不递归扫描 `**/SKILL.md` | 把 skill 放到 root 的直接子目录 |
| ask/chat 没 listing | 设置了 `NOVA_DISABLE_SKILLS=1` | 取消该环境变量 |
| 模型没有调用 skill | description / when_to_use 不够清晰 | 强化 description，或用 `/name` 显式要求 |
| token 明显变大 | skill 数量多或 description 过长 | 精简 description；M9 会截断 listing |

---

## 9. 交叉引用

- [M9 设计文档](../design/M9-skills.md)
- [M9 架构文档](../architecture/M9-architecture.md)
- [Roadmap](../roadmap.md)
