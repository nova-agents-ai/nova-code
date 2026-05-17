# M9 使用手册 — Skills 系统

> 面向终端用户 / 新人上手。M9 支持从项目或用户目录加载 `SKILL.md`，并在 ask/chat 中按 query 自动注入相关指导。

---

## 1. 前置条件

- Bun >= 1.3；
- 已配置 `NOVA_API_KEY` 或使用 `NOVA_TRANSPORT=mock` 做本地验证；
- skill 文件放在以下任一目录：
  - `<cwd>/.nova-code/skills/<name>/SKILL.md`
  - `~/.nova-code/skills/<name>/SKILL.md`
  - `~/.agents/skills/<name>/SKILL.md`

---

## 2. 创建一个 Skill

```bash
mkdir -p ~/.agents/skills/java
cat > ~/.agents/skills/java/SKILL.md <<'SKILL'
---
name: java
description: Java JVM backend and concurrency review skill.
---
# Java Skill

When reviewing Java code:
- Check transaction boundaries and exception semantics.
- Check concurrency safety for shared mutable state.
- Prefer explicit resource ownership and lifecycle notes.
SKILL
```

manual-only skill 示例：

```md
---
name: gstack
description: MANUAL TRIGGER ONLY: invoke only when user types /gstack.
---
# GStack
...
```

manual-only skill 不会被关键词自动激活，只能通过 `/gstack`、`$gstack` 或 `skill:gstack` 触发。

---

## 3. 查看与调试

```bash
nova-code skill list
nova-code skill show java
nova-code skill match "review this Java concurrency service"
```

输出示例：

```text
java    Java JVM backend and concurrency review skill.    /Users/me/.agents/skills/java/SKILL.md
```

`match` 会展示激活原因：

```text
java    keyword    score=4    java
```

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
```

行为说明：

- ask 每次只按当前问题匹配；
- chat 启动时加载 skill catalog，每轮按当前输入匹配；
- skill 注入不改变工具权限，Bash/FileWrite/FileEdit 仍按 M3 权限系统走；
- 最多自动注入 3 个 skill，超长正文会截断。

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

---

## 6. 端到端可复制验证脚本

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"
mkdir -p "$TMP_HOME/.agents/skills/java"
cat > "$TMP_HOME/.agents/skills/java/SKILL.md" <<'SKILL'
---
name: java
description: Java JVM backend and concurrency review skill.
---
# Java Skill
M9_MANUAL_VERIFICATION_MARKER
SKILL

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" nova-code skill match "review Java code"

LOG="$TMP_HOME/mock.jsonl"
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
  NOVA_API_KEY=sk-mock \
  NOVA_TRANSPORT=mock \
  NOVA_MOCK_SCENARIO=chat \
  NOVA_MOCK_LOG_FILE="$LOG" \
  nova-code ask "review Java code"

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
bun test src/commands/SkillCommand/SkillCommand.test.ts
bun test src/m9-e2e-skills.test.ts
```

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `No skills found.` | root 不对或文件名不是 `SKILL.md` | 跑 `nova-code skill list`，确认目录层级 |
| `match` 无结果 | skill 是 manual-only 或 description token 不匹配 | 用 `/name` 显式触发，或补充 description |
| ask/chat 没注入 | 设置了 `NOVA_DISABLE_SKILLS=1` | 取消该环境变量 |
| 同名 skill 不生效 | 更高优先级 root 已有同名 skill | `skill list` 看实际路径；project root 优先 |
| token 明显变大 | skill 正文过长 | 拆小 skill；M9 会截断但仍建议精简 |

---

## 9. 交叉引用

- [M9 设计文档](../design/M9-skills.md)
- [M9 架构文档](../architecture/M9-architecture.md)
- [Roadmap](../roadmap.md)
