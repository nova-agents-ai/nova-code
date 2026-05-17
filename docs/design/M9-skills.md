# M9 — Skills 系统

> 实施日期：2026-05-17
>
> 目标：支持加载 `~/.agents/skills/<name>/SKILL.md` 形态的领域提示词包，并按 claude-code 的运行模型：先向模型暴露 skill 名称/描述列表，再由模型通过 `Skill` tool 按需加载完整正文。

---

## 1. 设计总览

M9 把 Skills 作为“可装载的提示词包”，但不在本地做关键词 routing，也不把所有 skill body 预先塞进 system prompt。运行时流程如下：

```mermaid
flowchart LR
  ROOTS["skill roots"] --> LOAD["loadSkillCatalog"]
  LOAD --> PARSE["frontmatter + body"]
  PARSE --> LIST["formatSkillListingInstructions"]
  LIST --> SYS["buildSystemPrompt projectInstructions"]
  SYS --> LLM["LLM semantic choice"]
  LLM --> TOOL["Skill tool"]
  TOOL --> BODY["load selected SKILL.md body"]
```

默认 root 顺序：

1. `<cwd>/.nova-code/skills`
2. `~/.nova-code/skills`
3. `~/.agents/skills`

每个 root 只支持 claude-code 当前的目录形态：`<root>/<skill-name>/SKILL.md`。不会递归扫描任意深度的 `**/SKILL.md`。

---

## 2. Skill 文件形态

M9 对齐当前 `~/.agents/skills/<name>/SKILL.md` 的事实形态：

```md
---
name: Java Display Name
description: Java JVM backend and concurrency review skill.
allowed-tools:
  - Read
  - Grep
---
# Java Skill

具体指导内容……
```

frontmatter 解析采用零依赖 YAML 子集：

- 顶层 `key: value`
- block scalar：`description: |`
- 简单数组：`allowed-tools: [Read, Grep]` 或多行 `- Read`
- 基础 scalar：string / number / boolean

M9 只消费：`description`、`version`、`preamble-tier`、`allowed-tools`、`when_to_use`、`disable-model-invocation`、`user-invocable`。canonical skill name 与 claude-code `/skills/` 目录一致，来自目录名 `<skill-name>`；frontmatter `name` 当前仅作为兼容字段被解析但不作为命令名。`allowed-tools` 当前只展示/保留元数据，不参与权限放行。

---

## 3. 激活策略

M9 不再保留本地 matcher。运行时有两条对齐 claude-code 的入口：模型看 listing 后语义选择并调用 `Skill` tool；用户直接输入 `/name args` 时由本地 slash skill expansion 直接加载该 skill body。

工程取舍：

- 不在本地用 token overlap 做“伪语义匹配”；
- 不保留 `skill match` 这类字符匹配调试入口，避免误导运行时行为；
- 用户输入 `/name args` 时不走 `Skill` tool，而是本地直接展开 skill body 作为本轮 user prompt；
- 不预先注入 skill body，避免 prompt 膨胀和指令冲突；
- 默认把所有可模型调用的 skill 名称/描述列给模型，描述超预算时按 claude-code 思路截断；
- `disable-model-invocation: true` 的 skill 不进入模型可见 listing，也不生成 `Skill` tool 可调用项，但默认仍可由用户 `/name` 显式调用；
- `user-invocable: false` 的 skill 只能由模型通过 `Skill` tool 调用，用户 `/name` 会被拒绝。

---

## 4. Prompt 与 Tool 边界

System prompt / projectInstructions 中只放 skill listing：

```text
Available skills are listed below...

The following skills are available for use with the Skill tool:

- java: Java JVM backend and concurrency review skill.
```

完整正文有两种加载方式：模型调用 `Skill` tool，或用户直接输入 `/name args` 触发本地展开。`Skill` tool 返回：

```text
Base directory for this skill: /abs/path/to/java

<SKILL.md body>
```

边界控制：

- listing 默认预算 8k 字符，单条描述最多 250 字符；
- `Skill` tool 加载完整 body，并附带 skill base directory；
- `/name args` 直接调用同样会加载完整 body，并把 `$ARGUMENTS` 替换为 args；
- project/user instructions 仍声明为优先级更高；
- ask 每次加载 catalog 并暴露 listing；chat 启动时加载 catalog，每轮复用同一 listing。

---

## 5. CLI

保留：

```bash
nova-code skill list
nova-code skill show <name>
```

用途：

- `list`：确认当前 roots 下实际加载到了哪些 skill；
- `show`：查看某个 skill 的 description、manual-only / model-invocable / user-invocable 状态、路径与正文。

不再提供 `match` 子命令；运行时 skill 选择以 ask/chat 中的模型语义选择 + `Skill` tool 调用为准。

---

## 6. 与 claude-code 的差异

| 维度 | claude-code | nova-code M9 |
|---|---|---|
| 文件形态 | `~/.claude/skills/<name>/SKILL.md` | 兼容 `~/.agents/skills/<name>/SKILL.md` 与 `.nova-code/skills/<name>/SKILL.md` |
| 加载深度 | `/skills/` 下直接子目录，不递归 `**/SKILL.md` | 同步改为直接子目录 |
| 语义匹配 | 模型看 skill listing 后调用 `Skill` tool | 同款模型语义选择，不做本地关键词匹配 |
| body 注入 | 调用 Skill tool 或用户 slash skill 后才加载完整 body | 同款，不再把 body 预置到 projectInstructions |
| 权限 | skill 可声明 allowed tools | M9 只保留元数据，不改变 M3 权限系统 |

---

## 7. 测试覆盖

| 测试 | 覆盖点 |
|---|---|
| `src/services/skills/skills.test.ts` | frontmatter、root 解析、非递归加载、listing 不含 body |
| `src/tools/SkillTool/SkillTool.test.ts` | `Skill` tool 按名称加载 body、`disable-model-invocation` 过滤 |
| `src/commands/SkillCommand/SkillCommand.test.ts` | `skill list/show` CLI |
| `src/m9-e2e-skills.test.ts` | 子进程 ask + mock LLM，验证 system prompt 只含 listing，Skill tool 才返回 body |
| `src/commands.test.ts` / `src/cli.test.ts` | builtin command/help 注册 |

---

## 8. 后续预留

- `allowed-tools` 与 M3 permission rule 的安全映射；
- skill 安装/升级命令；
- slash skill direct expansion 的更多 UI/日志可观测性；
- project-local skill 热加载；
- 将 successful workflow 自动沉淀为 skill（Phase 3 Self-improvement）。

---

## 9. 交叉引用

- [M9 使用手册](../manual/M9-usage-guide.md)
- [M9 架构文档](../architecture/M9-architecture.md)
- [Roadmap](../roadmap.md)
