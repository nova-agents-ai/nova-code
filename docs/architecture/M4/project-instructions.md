# CLAUDE.md 4 层加载 + @include 算法

## 1. 入口

**位置**：`src/services/projectInstructions/`
**主入口**：`getProjectInstructions(params: GetProjectInstructionsParams): Promise<string | undefined>`

```ts
interface GetProjectInstructionsParams {
  cwd: string;
  homeDir?: string;          // 测试注入：覆盖 home
  managedDir?: string;       // 测试注入：覆盖 /etc/nova-code
  platform?: NodeJS.Platform; // Windows 自动跳过 managed 层
}
```

启动时（`ChatCommand.run` / `runAskWithLLM`）调一次，结果作为 `projectInstructions` 透传给 runAgentLoop。

## 2. 4 层加载顺序（由低到高）

```
managed     /etc/nova-code/CLAUDE.md            （Linux/macOS only；Windows 跳过）
user        ~/.nova-code/CLAUDE.md
project     for dir in [gitRoot, ..., cwd]:
              <dir>/CLAUDE.md
              <dir>/.nova-code/CLAUDE.md
local       for dir in [gitRoot, ..., cwd]:
              <dir>/CLAUDE.local.md
```

`gitRoot = findGitRoot(cwd)` —— 沿 cwd 向上扫，直到看到 `.git/`（或文件，worktree 场景）。找不到 git root 时退化为 `[cwd]`。

**优先级语义**：后加载者优先，因为拼接结果中靠后的内容模型更关注。这与 claude-code 的语义一致。

## 3. 输出格式

```
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

=== file: /etc/nova-code/CLAUDE.md ===
<content>

=== file: ~/.nova-code/CLAUDE.md ===
<content>

=== file: /repo/CLAUDE.md ===
<content>

=== file: /repo/sub/CLAUDE.md ===
<content>

=== file: /repo/CLAUDE.local.md ===
<content>
```

每个文件用 `=== file: <abs path> ===\n<content>` 分隔，便于模型识别来源。

QueryEngine 把这段字符串接到 `DEFAULT_SYSTEM_PROMPT` 之后：

```
<DEFAULT_SYSTEM_PROMPT>

<projectInstructions output>
```

## 4. @include 递归算法

**位置**：`src/services/projectInstructions/claudeMd.ts:loadFileWithIncludes`

```
loadFileWithIncludes(filePath, loaded[], visited{}, depth):
  abs = resolve(filePath)
  if visited.has(abs): return
  visited.add(abs)

  if depth > 0 and ext(abs) ∉ TEXT_FILE_EXTENSIONS:
    logEvent("tengu_claude_md_include_skipped_extension", { ext })
    return

  rawContent = await Bun.file(abs).text()    // 不存在 → 静默 noop；EACCES → logEvent
  tokens = new Lexer({ gfm: false }).lex(rawContent)
  strippedContent = stripHtmlCommentsFromTokens(tokens).content

  if depth < MAX_INCLUDE_DEPTH:              // 5 层
    includes = extractIncludePathsFromTokens(tokens, abs)  // basePath = file abs path
    for include in includes:
      loadFileWithIncludes(include, loaded, visited, depth + 1)

  loaded.push({ path: abs, content: strippedContent })  // ← 子文件先 push，parent 后 push
```

**关键不变式**：子文件先 push，parent 后 push → 子文件在拼接结果中靠前 → 优先级低于 parent。这与 claude-code 一致。

## 5. extractIncludePathsFromTokens

**位置**：`src/services/projectInstructions/claudeMd.ts:extractIncludePathsFromTokens`

### 5.1 marked Lexer + 递归遍历

把 markdown 用 `new Lexer({ gfm: false })` 切出 tokens，递归 `processElements`：
- `code` / `codespan` token → 跳过（fenced 与 inline code 内的 @path 都不算）
- `text` token → `extractPathsFromText(token.text, ...)`
- `html` token → 仅当含块级注释残留时（如 `<!-- note --> @./x.md`）扫残留段
- 容器 token（list / paragraph 等）→ 递归 `element.tokens` 与 `element.items`

### 5.2 匹配规则（claude-code 同款）

正则：`/(?:^|\s)@((?:[^\s\\]|\\ )+)/g`
- 允许行首或空格后的 `@path`（**inline 也算**）
- 路径中的转义空格 `\<space>` 当作字面空格的一部分
- 后处理：剥 `#` 之前的部分（fragment identifier）；把 `\ ` unescape 成空格

### 5.3 isValidIncludePath

接受：
- `./relative` / `../up` / `~/home`
- `/abs`（非纯 `/`）
- 首字符是 `[a-zA-Z0-9._-]` 的相对路径

拒绝：
- 纯 `/`
- 以 `@` 起始（防 @-mention 链式触发）
- 以 `[#%^&*()]` 起始

### 5.3 路径解析

| 写法 | 解析为 |
|---|---|
| `@/abs/path` | 直接 `/abs/path`（绝对） |
| `@~/x` | `homedir() + "/" + "x"` |
| `@./relative` | `resolve(baseDir, "./relative")` |
| `@../up` | `resolve(baseDir, "../up")` |
| `@relative` | `resolve(baseDir, "relative")`（同 `@./relative`） |

`baseDir` = 当前 include 所在文件的目录。

## 6. 安全保证

| 风险 | 防护 |
|---|---|
| 循环 @include（A → B → A） | `visited: Set<string>` 用绝对路径做键，每个文件最多加载一次 |
| 无限递归（深 @include 树） | `MAX_INCLUDE_DEPTH = 5`；超过即停止追加新的 include |
| 文件不存在 | `Bun.file(abs).exists()` 检测，不存在 → 静默跳过 |
| 文件不可读（权限） | try/catch 整个加载块，异常 → 静默跳过 |
| 损坏的 markdown | 不解析 markdown 结构（只查独立行 + fenced block），损坏内容直接进 system prompt |
| 启动卡死 | 全部用 `Bun.file().text()` 异步 IO；磁盘慢会拖慢启动但不会死锁 |

## 7. 与 claude-code 的差异

| 维度 | claude-code | nova-code |
|---|---|---|
| 子目录扫描 | `.claude/CLAUDE.md` + `.claude/rules/*.md` | 仅 `.nova-code/CLAUDE.md`（rules 子目录 M4 不实现） |
| frontmatter `paths` | 支持，按文件路径 glob 决定是否激活 | 不支持，整个文件内容均加载 |
| HTML comment 剥离 | marked lexer 识别块级注释并剥离（保留 inline） | **同款实现**：`stripHtmlCommentsFromTokens`，保留 inline 与 code 内的注释 |
| MEMORY.md 截断 | 触发 `truncateEntrypointContent` | 不实现 |
| 文件大小限制 | `MAX_MEMORY_CHARACTER_COUNT = 40_000` | 不限制（用户自负） |
| @include 文件类型限制 | 维护 `TEXT_FILE_EXTENSIONS` 白名单 | **同款实现**：约 80 种扩展名，含主流编程语言 / 配置 / 文档 |
| @include 路径校验 | regex + isValidPath + fragment 剥离 + escaped space | **同款** |
| @include 错误埋点 | `logEvent("tengu_claude_md_permission_error", ...)` | **同款**（走 services/analytics） |

简化原因：M4 范围控制；frontmatter glob / claudeMdExcludes settings / MEMORY.md 截断都依赖 claude-code 的 settings 与 Skills 系统，留到 M9 Skills 统一引入。

## 8. 测试覆盖

`claudeMd.test.ts` 18 用例：
- extractIncludePaths：相对/绝对/~ 路径、fenced 跳过、**inline @path 算 include**、**inline code 内不算**、**fragment 剥离**、**escaped space**、**非法形态拒绝**、空字符串
- getProjectInstructions：
  - 没有任何文件 → undefined
  - 仅 user / 仅 project / 仅 local 任一层
  - project + local 顺序（local 在结果中靠后）
  - @include 子文件先于 parent + 都出现
  - 循环 @include 不死循环
  - Windows 跳过 managed
  - 非 Windows 加载 managed
  - dirChain 从 git root 到 cwd 都扫

e2e（`m4-e2e-compact.test.ts` 用例 d）验证：CLAUDE.md（含 @include）注入到 system 字段，子进程内由真实 `getProjectInstructions` 加载。
