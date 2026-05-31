# M16 使用手册：持久化记忆系统（Auto Memory）

> 适用版本：M16 持久化记忆系统之后
>
> 面向对象：希望让 nova-code 跨会话记住你的偏好、纠正、项目背景的用户。

---

## 1. 前置与安装

```bash
bun install
bun run typecheck
bun test
bun run check
```

M16 不新增外部依赖；运行时仍以 Bun + TypeScript 为准。

---

## 2. 默认行为

**默认开启**。第一次 `nova-code chat` / `nova-code ask` 时会自动：

1. 创建 `~/.nova-code/memory/projects/<sanitize(git-root|cwd)>/` 目录
2. 把 4 类记忆指令注入 system prompt，教会模型何时该写、写到哪、写成什么格式
3. 每轮 user input 异步用 LLM 二级调度从已有 memory 中挑出最相关的 ≤5 条注入对话
4. 端 turn 后台触发 extractor 兜底，从主对话里提取值得记忆的内容

模型主动用 `FileWrite` / `FileEdit` 写到 memory 目录内时，**权限引擎自动放行**，不弹审批。

---

## 3. 配置

### 3.1 关闭

任一方式即可：

```bash
# 环境变量（一次性）
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 nova-code chat

# 持久化配置
nova-code config set autoMemoryEnabled false
```

### 3.2 自定义记忆基础目录

```bash
NOVA_MEMORY_DIR=/path/to/shared/memory nova-code chat
```

默认是 `~/.nova-code/memory`；env 覆盖后所有项目的 memory 都落到该路径下的 `projects/<key>/` 子目录。

### 3.3 查看当前配置

```bash
nova-code config get autoMemoryEnabled    # 默认 true
nova-code config get                       # 完整配置（apiKey 脱敏）
```

---

## 4. 目录布局

```
~/.nova-code/memory/
├── projects/
│   └── -Users-you-code-my-repo/        # sanitize(git root or cwd)
│       ├── MEMORY.md                    # 索引文件，常驻 system prompt
│       ├── user_role.md                 # 4 type 之一的 topic 文件
│       ├── feedback_testing.md
│       └── project_q4_freeze.md
```

- 同一 git 仓库下不同 worktree **共享一份记忆**（git canonical root 作为 key）
- 非 git 目录退化到按 cwd 分桶
- `MEMORY.md` 是索引（无 frontmatter），每行 `- [Title](file.md) — one-line hook`
- topic 文件含 frontmatter：`name` / `description` / `type`

---

## 5. 4 类记忆

| Type | 用途 | 触发场景 |
|---|---|---|
| `user` | 用户角色 / 偏好 / 知识背景 | "我是 Go 资深工程师，第一次接触本项目 React" |
| `feedback` | 用户给过的纠正 / 确认（必含 Why + How to apply） | "不要 mock 数据库 —— 上季度因此踩过坑" |
| `project` | 工作进展 / 决策 / 截止（含绝对日期） | "2026-05-28 起冻结非关键合并，移动端切 release 分支" |
| `reference` | 外部系统指针 | "Pipeline 缺陷追踪在 Linear 'INGEST' 项目" |

**禁止保存**：代码模式、架构、文件路径、git 历史、调试 fix recipe、CLAUDE.md 已涵盖内容、临时任务状态。

详细文案见 `src/services/memory/promptText.ts`（也是注入 system prompt 的源文件）。

---

## 6. 端到端验证脚本

```bash
# 1. 基线三件套（无环境改动）
bun run typecheck && bun test && bun run check

# 2. 干净启动 chat，让模型记下一条偏好
rm -rf "$HOME/.nova-code/memory"     # 清掉旧记忆（仅本验证用！）
nova-code chat
> 记一下：我是 Go 工程师，第一次接触 React。
> /exit

# 3. 查看模型有没有真的落盘
ls ~/.nova-code/memory/projects/*/
cat ~/.nova-code/memory/projects/*/MEMORY.md

# 4. 重开 chat，验证模型能基于记忆作答
nova-code chat
> 请用我熟悉的视角解释 useEffect

# debug 模式可以看 system prompt 是否含 MEMORY.md 内容：
nova-code chat --debug
# stderr 会打印 chat-llm-*.log 路径；打开它，搜 "## MEMORY.md"
```

### 6.1 关闭后行为退化验证

```bash
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 nova-code ask "hello" --debug
# 打开 ask-llm-*.log；搜 "# auto memory" 应该找不到
```

---

## 7. 提交前校验矩阵

| 命令 | 作用 | 失败时手段 |
|---|---|---|
| `bun run typecheck` | TS 类型检查 | 修类型签名 / import |
| `bun test` | bun:test 单测全量 | 修被测代码或测试期望 |
| `bun run check` | biome lint + format | 优先 `bun run check:fix` 自动修 |

新增 M16 测试覆盖（90+ tests）：
- 单测：`src/services/memory/*.test.ts`（8 文件）
- 集成：`src/QueryEngine.test.ts` 新增 M16 描述块
- 权限：`src/services/permissions/permissionEngine.test.ts` 新增 carve-out 描述块
- e2e：`src/m16-e2e-memory.test.ts`

---

## 8. 故障排查

| 现象 | 可能原因 | 检查 |
|---|---|---|
| 模型不主动写记忆 | system prompt 没注入 | `nova-code chat --debug` → 打开 chat-llm 日志，搜 `# auto memory`；若找不到检查 `autoMemoryEnabled` |
| 写记忆时被弹权限询问 | 路径不在 memoryDir 内 / carve-out 未生效 | 看模型实际传给 FileWrite 的 path；应在 `~/.nova-code/memory/projects/<key>/` 下 |
| 重开 chat 看不到上轮记忆 | git root / cwd 变化导致 project key 变了 | `ls ~/.nova-code/memory/projects/` 列出所有桶；找到上次的那个 |
| 每轮 chat 都额外跑一次 LLM 调用很慢 | per-turn relevance selector | 关掉 memory：`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| extractor 提取出无关内容 | 主对话上下文不够 substantive | 提示模型直接调 FileWrite 写指定 memory；主对话写过后 extractor 互斥跳过 |
| 在非 git 目录下，scratch 目录的记忆和主项目混淆 | cwd fallback 把每个工作目录单独分桶（正常行为） | 用 `NOVA_MEMORY_DIR` 全局指向一个统一目录，或避免在 scratch 启动 chat |

---

## 9. 进阶：手动编辑

记忆文件就是普通 Markdown，可以手动编辑：

```bash
cd ~/.nova-code/memory/projects/<key>/
$EDITOR feedback_testing.md
# 编辑后 chat 下一轮就能看到
```

格式约束：
- frontmatter 必有 `name` / `description` / `type`（type ∈ user/feedback/project/reference）
- 文件名建议 `<type>_<topic>.md` 风格（不强制）
- 在 `MEMORY.md` 索引里加一行 `- [Title](文件名.md) — one-line hook`

---

## 10. 与 claude-code 的差异

| 维度 | claude-code | nova-code |
|---|---|---|
| 默认目录 | `~/.claude/projects/<key>/memory/` | `~/.nova-code/memory/projects/<key>/` |
| 团队记忆 | `team/` 子目录 + 同步 | 暂不支持（后续 milestone） |
| KAIROS 日志 | 长会话 daily log 模式 | 不支持（CLI 用不上） |
| 关闭 env | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 同名兼容 |
| 自定义目录 env | `CLAUDE_CODE_REMOTE_MEMORY_DIR` | `NOVA_MEMORY_DIR` |

详见 [`docs/design/M16-memory.md`](../design/M16-memory.md) §8。

---

## 11. 交叉引用

- [M16 设计文档](../design/M16-memory.md)
- [M16 架构文档](../architecture/M16-architecture.md)
- [Roadmap](../roadmap.md)
