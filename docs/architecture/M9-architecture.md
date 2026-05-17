# nova-code 架构文档 · M9

> 适用版本：M9 修正之后（Skills catalog + model-facing listing + Skill tool body loading）
> 基线日期：2026-05-17
> 文档目标：说明 M9 新增模块、数据流、集成点与测试边界。

---

## 1. 模块布局

```text
src/services/skills/
├── types.ts              LoadedSkill / SkillCatalog
├── frontmatter.ts        SKILL.md frontmatter 子集解析
├── skillLoader.ts        root 解析 + 直接子目录 SKILL.md 加载
├── skillPrompt.ts        skill listing / Skill tool body 格式化 + mergeInstructionBlocks
├── skillSlash.ts         用户 `/name args` 显式调用的本地 skill body 展开
├── index.ts
└── skills.test.ts

src/tools/SkillTool/
├── constants.ts          Skill 工具名
├── SkillTool.ts          createSkillTool(skills)
└── SkillTool.test.ts

src/commands/SkillCommand/
├── SkillCommand.ts       skill list/show
└── SkillCommand.test.ts

src/m9-e2e-skills.test.ts 子进程 ask + mock LLM listing/body 注入验证
```

---

## 2. 数据模型

```ts
interface LoadedSkill {
  name: string;
  description: string;
  path: string;
  directory: string;
  body: string;
  metadata: SkillMetadata;
}

interface SkillMetadata {
  name: string;
  description: string;
  allowedTools?: readonly string[];
  whenToUse?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  manualOnly: boolean;
}
```

`SkillCatalog` 包含：

- `skills`：已加载、按名称排序的 skill；
- `roots`：实际扫描的 roots；
- `warnings`：不可读、重复、格式非法等非致命问题。

---

## 3. 加载流程

```mermaid
sequenceDiagram
  participant CMD as Ask/Chat/SkillCommand
  participant L as loadSkillCatalog
  participant FS as Filesystem
  participant P as parseSkillDocument

  CMD->>L: cwd/home/env
  L->>L: resolveSkillRoots
  L->>FS: readdir root immediate children
  FS-->>L: <skill-name>/SKILL.md
  L->>P: frontmatter + body
  P-->>L: metadata/body
  L-->>CMD: SkillCatalog
```

加载策略：

- `NOVA_DISABLE_SKILLS=1` 直接返回空 roots；
- `NOVA_SKILL_DIRS` 存在时覆盖默认 roots；
- 每个 root 只加载直接子目录的 `SKILL.md`，不递归扫描 `**/SKILL.md`；
- canonical skill name 来自目录名；
- 同名 skill 用小写 name 去重，先发现者保留；
- IO 错误不阻断命令，只进入 warnings。

---

## 4. ask/chat 集成

ask：

```mermaid
flowchart TD
  ASK["runAskWithLLM(question)"] --> PI["getProjectInstructions"]
  ASK --> CAT["loadSkillCatalog"]
  CAT --> LIST["formatSkillListingInstructions"]
  PI --> MERGE["mergeInstructionBlocks"]
  LIST --> MERGE
  CAT --> TOOL["createSkillTool(skills)"]
  MERGE --> LOOP["runAgentLoop(projectInstructions)"]
  TOOL --> LOOP
```

chat：

```mermaid
flowchart TD
  CHAT["ChatCommand"] --> CAT["loadSkillCatalog once"]
  CAT --> TOOL["createSkillTool(skills)"]
  CAT --> REPL["runChatRepl(skills)"]
  REPL --> TURN["each user turn"]
  TURN --> LIST["formatSkillListingInstructions"]
  LIST --> LOOP["session.sendTurn(projectInstructions)"]
  TOOL --> LOOP
```

为什么仍复用 `projectInstructions` 字段：

- QueryEngine 已经有“追加到 system prompt 末尾”的稳定通道；
- compact forked-agent 与主循环使用同一套 system prompt 构造逻辑；
- 避免为 M9 改动 Anthropic SDK request shape。

关键变化：`projectInstructions` 只包含 model-invocable skill listing，不包含完整 body。`disable-model-invocation: true` 的 skill 会被排除在 listing 与 `Skill` tool 之外；但只要 `user-invocable` 没设为 `false`，用户仍可通过 `/name args` 直接触发本地展开。完整 body 只在 `Skill` tool 调用或用户 slash skill 调用时加载。

---

## 5. Skill CLI

`SkillCommand` 是纯本地命令，不需要 API key：

- `list`：输出 `name / description / path`；
- `show <name>`：输出元数据与正文。

M9 不再保留 `match` 子命令，也没有本地语义 matcher；ask/chat 的普通语义选择依赖模型看 listing 后调用 `Skill` tool。用户 `/name args` 是另一条确定性本地展开路径，不经过 `Skill` tool。CLI options 在测试中可注入 `cwd/homeDir/env/io`，生产路径默认使用 `process.cwd()` 与当前环境。

---

## 6. 权限与安全边界

M9 不让 skill 获得任何执行特权：

- `allowed-tools` 当前只是 metadata；
- `Skill` tool 本身只读取已加载 catalog 中的 `SKILL.md` body；
- skill body 只是 prompt 指令，不会动态注册工具；
- 后续 tool call 仍全部进入 M3 permission pipeline；
- 不读取 `SKILL.md` 以外的任意引用文件，避免技能包扩散加载面。

---

## 7. 测试策略

| 层级 | 文件 | 断言 |
|---|---|---|
| Parser | `skills.test.ts` | block scalar / arrays / metadata |
| Loader | `skills.test.ts` | roots / manual-only / env override / 非递归加载 |
| Prompt | `skills.test.ts` | model-facing listing 不包含 body；`disable-model-invocation` 过滤 |
| Slash | `skills.test.ts` | 用户 `/name args` 本地展开；`user-invocable=false` 拒绝 |
| Tool | `SkillTool.test.ts` | Skill tool 加载完整 body |
| CLI | `SkillCommand.test.ts` | list/show/错误 action |
| E2E | `m9-e2e-skills.test.ts` | ask 的 mock log systemSnippet 只含 listing；toolResultText 包含 body |

---

## 8. 交叉引用

- [M9 设计文档](../design/M9-skills.md)
- [M9 使用手册](../manual/M9-usage-guide.md)
- [Roadmap](../roadmap.md)
