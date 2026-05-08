# 04 · Tools —— 工具系统与 7 个内置工具

> 对应文件：[src/Tool.ts](../../src/Tool.ts) / [src/tools.ts](../../src/tools.ts) / [src/tools/*](../../src/tools)
> 设计稿：[docs/design/M1-tools.md](../design/M1-tools.md)

---

## 1. 两条核心骨架

```
src/Tool.ts          (61 行)  ─────────┐
  Tool 接口 / ToolInputSchema /         │ 
  ToolExecutionContext                  │
                                        ↓
src/tools.ts         (50 行)    聚合注册表 + findTool
  builtinTools = [LS, FileRead,         │
      FileWrite, FileEdit, Bash,        │
      Grep, Glob]                       │
                                        ↓
src/tools/utils.ts   (238 行)   所有工具共享的 helper + 常量
                                        │
                     ┌──────────────────┼──────────────────┐
                     ↓                  ↓                  ↓
         tools/<ToolName>/      tools/<ToolName>/   tools/<ToolName>/
           <ToolName>.ts        <ToolName>.test.ts       ...
           （7 份实现）           （7 份测试）
```

**设计原则**：

- **顶层 `Tool.ts` 只放接口**，零依赖。
- **顶层 `tools.ts` 只做注册表 + `findTool`**。新增工具只改这里一处。
- **每个工具独立子目录**：实现与测试紧贴。
- **工具之间不互相 import**。共享逻辑一律上抬到 `tools/utils.ts`。
- **工具不感知 agent loop**。`execute` 只吃 `input + context`，吐字符串或抛错。

---

## 2. `Tool` 接口

```ts
// src/Tool.ts
interface Tool {
  readonly name: string;                  // PascalCase，如 "Bash" / "FileEdit"
  readonly description: string;           // 发给 LLM 的工具说明
  readonly input_schema: ToolInputSchema; // JSON Schema (object type)
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ) => string | Promise<string>;
  readonly requiresApproval?: boolean;    // M1 只埋字段，agent loop 不读
}

interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

interface ToolExecutionContext {
  readonly signal: AbortSignal;           // Ctrl+C 中断
}
```

几条"不明写但须理解"的约束：

1. `execute` **必须返回字符串**——它是 `tool_result.content`，由模型读。返回对象请自行 `JSON.stringify`。
2. `execute` 抛错由 agent loop 包装后以 `is_error=true` 的 tool_result 反馈模型，**不**终止 loop。模型会看到错误并自我纠正。
3. 工具内部若需响应 abort，应定期检查 `context.signal.aborted` 并抛 `new AbortError()`；阻塞操作（`spawn` / 长 IO）要把 signal 传下去或手动 kill。
4. 工具返回的字符串**不会**被 nova-code 截断——工具自己应在实现里做大小截断（参考 `FileReadTool` / `BashTool` / `GrepTool`）。

---

## 3. 注册与查找

```ts
// src/tools.ts
export const builtinTools: readonly Tool[] = [
  LSTool, FileReadTool, FileWriteTool, FileEditTool,
  BashTool, GrepTool, GlobTool,
];

export function findTool(name: string, tools: readonly Tool[]): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}
```

- 严格相等查找（不做模糊匹配）。模型瞎编名字时返回 `undefined`，由 agent loop 转为 `Unknown tool '...'` 反馈。
- 顺序只影响 `--help` 展示，不影响功能。
- `O(n)` 查找完全够用。M8 引入 MCP 工具后再换 Map。

---

## 4. 共享常量与 helper（`tools/utils.ts`）

### 4.1 常量（全部集中在 `TOOL_LIMITS` 对象）

| 常量 | 值 | 使用者 |
|---|---|---|
| `MAX_FILE_BYTES` | `1 MB` | FileRead |
| `MAX_DIR_ENTRIES` | `500` | LS |
| `BASH_MAX_OUTPUT_BYTES` | `1 MB` | Bash |
| `BASH_DEFAULT_TIMEOUT_MS` | `30_000` | Bash |
| `BASH_MAX_TIMEOUT_MS` | `300_000` (5 min) | Bash |
| `BASH_SIGTERM_GRACE_MS` | `500` | Bash |
| `BASH_SIGKILL_GRACE_MS` | `1000` | Bash |
| `WRITE_MAX_FILE_BYTES` | `5 MB` | FileWrite |
| `EDIT_MAX_FILE_BYTES` | `1 MB` | FileEdit |
| `GREP_MAX_MATCHES` | `200` | Grep |
| `GREP_MAX_LINE_BYTES` | `2_000` | Grep |
| `GLOB_MAX_RESULTS` | `500` | Glob |
| `SEARCH_IGNORE_DIRS` | `[".git", "node_modules", "dist", "build", ".venv", ".next", ".nova-code"]` | Grep / Glob |

### 4.2 helper

| helper | 职责 | 被谁用 |
|---|---|---|
| `requireStringField(input, field, toolName)` | 必填字符串校验，缺失或类型错抛 `ToolExecutionError` | 所有工具 |
| `describeType(value)` | unknown → 类型名（`"undefined"`/`"null"`/`"array"`/typeof） | 错误消息 |
| `describeError(error)` | unknown → 错误消息字符串 | 所有工具 |
| `sanitizePathForMessage(abs)` | `/Users/foo/...` → `~/...`（脱敏） | FileEdit / FileWrite / Grep / Bash |
| `validateCwd(cwd, toolName)` | 5 分支校验：undefined/非 string/不存在/非目录/无读权限 | Bash / Glob |
| `isIgnoredPath(rel, ignoreDirs)` | 任一路径段**精确**等于 ignoreDirs 中某项即跳过 | Grep / Glob |

**脱敏用途**：错误消息 / 工具元数据才脱敏。用户 `Bash(command)` 的 `stdout` / `stderr` **不**脱敏——那是用户自己要的产物，不该改动。

---

## 5. 7 个内置工具

> 下面每个工具给出 **name / 关键约束 / 输入 schema / 关键常量 / 典型失败模式**。完整实现看各自 `.ts` 文件，完整设计看 [M1-tools.md](../design/M1-tools.md)。

### 5.1 `LS` —— 列目录

- **文件**：[src/tools/LSTool/LSTool.ts](../../src/tools/LSTool/LSTool.ts)（75 行）
- **描述**：列出目录下的 files 和 subdirectories，最多 500 项
- **input**：`{ path: string }`（必填；绝对或相对 cwd）
- **典型失败**：path 不存在 / 非目录 / 无读权限

注：claude-code 没有 `LS`（用 `Glob` 代替），nova-code 保留是 roadmap §7.0 允许的"小幅偏离 #1"。

### 5.2 `FileRead` —— 读文件

- **文件**：[src/tools/FileReadTool/FileReadTool.ts](../../src/tools/FileReadTool/FileReadTool.ts)（73 行）
- **描述**：读取文本文件，超过 `MAX_FILE_BYTES` (1 MB) 截断
- **input**：`{ path: string }`
- **典型失败**：path 非 regular file / 读权限 / 编码非 UTF-8（会触发 replacement char）

### 5.3 `FileWrite` —— 创建新文件

- **文件**：[src/tools/FileWriteTool/FileWriteTool.ts](../../src/tools/FileWriteTool/FileWriteTool.ts)（127 行）
- **关键约束**：**只创建，不覆盖**（`flag: "wx"`），已存在则抛错提示改用 `FileEdit`
- **描述**：内容上限 `WRITE_MAX_FILE_BYTES` (5 MB)，父目录自动 mkdir -p
- **input**：`{ path: string, content: string }`
- **requiresApproval**: `true`
- **不做**：路径越界检查（`..` 跨出 cwd）—— M3 权限系统统一职责

### 5.4 `FileEdit` —— 字符串替换编辑

- **文件**：[src/tools/FileEditTool/FileEditTool.ts](../../src/tools/FileEditTool/FileEditTool.ts)（509 行）
- **关键约束**（M1 最关键工具）：
  1. **`old_string` 必须唯一**（N=0 / N>1 都拒绝）—— 模型必须扩大上下文使其唯一，或显式 `replace_all=true`
  2. **no-op 拒绝**：`old_string === new_string` → 抛错
  3. **原子写**：tmp + rename，tmp 名带 pid + 6 位 hex 随机数
  4. **不 fsync**（性能取舍：断电不在考虑范围）
  5. **多 hunk diff 输出**：最多显示前 3 hunk，超出用 `... (X more hunks omitted)`
- **input**：`{ path: string, old_string: string, new_string: string, replace_all?: boolean }`
- **requiresApproval**: `true`
- **不支持**：行号编辑、正则替换（模型容易算错或误伤）

### 5.5 `Bash` —— 执行 shell

- **文件**：[src/tools/BashTool/BashTool.ts](../../src/tools/BashTool/BashTool.ts)（411 行）
- **关键不变量**：
  1. **工具不阻塞 agent loop**：超时三段式
     ```
     t=0           spawn /bin/sh -c command
     t=timeout     SIGTERM                         (默认 30s，上限 5 min)
     t=+500ms      SIGKILL  (BASH_SIGTERM_GRACE_MS)
     t=+1500ms     detach + 立即返回 zombie 提示   (BASH_SIGKILL_GRACE_MS)
     ```
  2. **输出格式严格规范化**：6 条 regex 约束（见设计稿 §4.1），模型可正则解析退出码
  3. **输出上限**：stdout + stderr 合并 > `BASH_MAX_OUTPUT_BYTES` (1 MB) 中段截断

- **安全过滤**（双层）：

  **硬黑名单**（命中即拒绝，命令不执行）：
  | 名称 | 正则 |
  |---|---|
  | `rm-rf-root` | `\brm\s+(-[rRfF]+\s+)+\/(\s\|$)` |
  | `rm-rf-root-glob` | `\brm\s+(-[rRfF]+\s+)+\/\*` |
  | `dd-to-disk` | `\bdd\s+.*\bof=\/dev\/(sd\|nvme\|disk)` |
  | `mkfs` | `\bmkfs\b` |
  | `redirect-to-disk` | `>\s*\/dev\/sd[a-z]` |
  | `fork-bomb` | `:\(\)\{\s*:\|:&\s*\};:` |

  **软警告**（命中后在 result 前加 `[WARN: name]` 前缀，仍执行）：
  | 名称 | 正则 |
  |---|---|
  | `curl-pipe-shell` | `\b(curl\|wget)\s+[^\|]*\|\s*(sh\|bash\|zsh)\b` |
  | `sudo` | `\bsudo\b` |
  | `remote-write` | `\b(scp\|rsync)\s+\S+\s+\S+:` |

- **input**：`{ command: string, cwd?: string, timeout_ms?: number }`
- **requiresApproval**: `true`
- **不做**（M1 范围外）：cwd 路径白名单、内容过滤 / 密钥脱敏（均由 M3 权限系统接管）、流式输出回传（M5+）

### 5.6 `Grep` —— 内容搜索

- **文件**：[src/tools/GrepTool/GrepTool.ts](../../src/tools/GrepTool/GrepTool.ts)（553 行）
- **关键策略**：
  1. **优先 ripgrep**：进程级 lazy + cached 检测；存在则 `spawn("rg", [...])`
  2. **Node fallback**：rg 不可用 **或** 运行时 exitCode ∉ {0,1} → 同次调用内降级走 Node 实现
  3. **黑名单目录**：自动跳过 `SEARCH_IGNORE_DIRS`（通过 `isIgnoredPath`）
  4. **截断**：匹配数 > 200 整体截断；单行 > 2000 字节该行截断
  5. **测试钩子**：`_resetRipgrepCache()` 仅供单测
- **input**：`{ pattern: string, path?: string, case_sensitive?: boolean, include_glob?: string }`
- **不读 .gitignore**（M1 简化；M3+ 再评估）

### 5.7 `Glob` —— 文件名通配

- **文件**：[src/tools/GlobTool/GlobTool.ts](../../src/tools/GlobTool/GlobTool.ts)（130 行）
- **关键策略**：
  1. 使用 `Bun.Glob`（Bun 1.3+ 内置，零依赖，AsyncIterable 便于早期截断）
  2. 手动过滤 `SEARCH_IGNORE_DIRS`（Bun.Glob 不支持 ignore 选项）
  3. **按 mtime 倒序**：最近修改优先，便于模型聚焦活跃文件
  4. 结果 > 500 提前 break 迭代省 IO
- **input**：`{ pattern: string, cwd?: string }`

---

## 6. 常见任务的工具组合

```
探索项目                  LS  → FileRead
按名找文件                Glob → FileRead
按内容找引用              Grep → FileRead → FileEdit
新建模块                  FileWrite (组件) → FileEdit (注册到入口)
运行测试                  Bash("bun test")
重构                      Grep (找调用) → FileEdit × N → Bash ("bun check")
```

`LS` 与 `Glob` 的区别：

- `LS` 只看一层目录，便于知道"这个目录下有什么"
- `Glob` 递归匹配整棵树，便于知道"整个仓库哪些文件符合模式"

模型应该优先 `Glob`；`LS` 只在"看单个目录内容结构"时用。

---

## 7. 新增工具的 5 步清单

1. `mkdir src/tools/FooTool`
2. 在 `src/tools/FooTool/FooTool.ts` 导出 `export const FooTool: Tool = { name: "Foo", description, input_schema, execute }`
3. 如果有跨工具共享的常量/helper → 加到 `src/tools/utils.ts`
4. `src/tools.ts` 里 `import FooTool` 并加入 `builtinTools` 数组
5. `src/tools/FooTool/FooTool.test.ts` 写单测；必要时补 `src/integration.test.ts` 的用例

**约定**：

- `name` PascalCase（LLM 会收到）
- 文件名与 `name` + "Tool" 一致（如 `FooTool.ts`）
- `description` 第一段写"能做什么"，第二段写"不能做什么"——约束比能力更值得让模型看到
- 凡写磁盘 / 执行命令的工具 `requiresApproval: true`
- execute 内部**不要 console.log**（会污染 stdout；真要调试通过测试打印或 debug sink）

---

## 8. 工具与 agent loop 的交互契约（再次强调）

```
agent loop                              tool
┌──────────────────────────┐           ┌──────────────────────────┐
│ yield tool_call(use)     │           │                          │
│                          │           │                          │
│ executeOneTool(use,…)    │──input──→ │ execute(input, {signal}) │
│                          │           │   ↓                      │
│                          │           │   做事                    │
│                          │←─string── │   返回 string             │
│                          │           │   / 抛 Error              │
│ settle = allSettled(...)  │           │                          │
│                          │           │                          │
│ fulfilled?                │           │                          │
│  → tool_result(content)  │           │                          │
│ rejected?                 │           │                          │
│  → tool_result(           │           │                          │
│     describeToolError,   │           │                          │
│     is_error=true)       │           │                          │
└──────────────────────────┘           └──────────────────────────┘
```

所有工具错误都会被 `describeToolError` 包成字符串回灌给模型（见 [agent-loop.md §5.2](./agent-loop.md)），模型下一轮看到后自己纠正——这是为什么"抛清晰的错误消息"比"返回 success=false"更重要。
