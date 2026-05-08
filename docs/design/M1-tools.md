# M1 设计稿：工具系统补齐

> 版本：v2.2 · 创建日期：2026-05-01
> 路线图引用：[`docs/roadmap.md`](../roadmap.md) → Phase 1 · M1（含 §7.0 与 claude-code 结构对齐原则）
> 状态：**Under Review（plan-eng-review 进行中）**

---

## 一、目标与非目标

### 1.1 目标

让 nova-code 的工具集从"只能看"升级到"读 → 改 → 跑 → 验证"完整闭环。完成 M1 后，模型应能自主完成"批量改文件名 + 同步改 import + 跑测试验证"这类任务。

新增 5 个工具（命名完全按 roadmap §7.0 对齐 claude-code，PascalCase + Tool 后缀，`Tool.name` 字段同样使用 PascalCase）：

| 工具类名 | 工具 name 字段（LLM 看到的） | 用途 | 副作用 | 危险度 | claude-code 对应 |
|---|---|---|---|---|---|
| `BashTool` | `Bash` | 执行 shell 命令 | 高 | 🔴 极高 | `src/tools/BashTool/` |
| `FileWriteTool` | `FileWrite` | 创建新文件 | 中 | 🟡 中 | `src/tools/FileWriteTool/` |
| `FileEditTool` | `FileEdit` | 字符串替换式编辑 | 中 | 🟡 中 | `src/tools/FileEditTool/` |
| `GrepTool` | `Grep` | 文件内容检索 | 无 | 🟢 低 | `src/tools/GrepTool/` |
| `GlobTool` | `Glob` | 文件名通配匹配 | 无 | 🟢 低 | `src/tools/GlobTool/` |

> **类名 vs name 字段**：两者都对齐 claude-code，**类名 = `<Name>Tool`，`Tool.name` 字段 = `<Name>`**（去掉 Tool 后缀）。例：`BashTool.name === "Bash"`。
>
> **为什么对齐**：`Tool.name` 进入用户的对话历史 / debug 日志 / 错误消息，**改动是单向门**。M1 上线前对齐避免后续 resume 旧 session / 读旧 log 的兼容性问题，也避免 LLM 把工具名误解为自然语言短语。
>
> **M0 已有工具同步重命名**：`list_dir` → `LS`、`read_file` → `FileRead`（类 `LSTool` / `FileReadTool`，name 字段 `LS` / `FileRead`）。

### 1.2 非目标（M1 不做，留给后续 milestone）

- ❌ **权限询问 UI**：M3 才做。M1 仅在 Tool 接口埋 `requiresApproval` 字段，agent loop 暂不消费
- ❌ **危险命令拦截规则的完整体系**：M1 只做最小黑名单（`rm -rf /` 等明显灾难），完整策略 M3 一起做
- ❌ **Tool 接口的 transport 层抽象**：M1.5 重构窗口做
- ❌ **多文件 batch 编辑**：用 `FileEdit` 多次调用即可，不引入新工具
- ❌ **diff 预览 / 用户确认编辑**：M3 权限系统的一部分
- ❌ **重命名 / 移动文件**：用 `Bash` + `mv` 即可，不需要专门工具
- ❌ **自定义 ripgrep 规则文件（.rgignore）**：M2 之后

### 1.3 成功标准（DoD）

1. **5 个新工具全部上线**，每个有完整单测
2. **`Tool` 接口扩展**：新增 `requiresApproval?: boolean` 字段，所有写权工具标 `true`
3. **目录结构对齐 claude-code**（按 roadmap §7.0）：
   - `src/llm/types.ts` 中的 `Tool` 接口搬到 `src/Tool.ts`（顶层）
   - `src/llm/tools.ts` 拆为 `src/tools.ts`（注册表）+ `src/tools/<ToolName>/<ToolName>.ts`（每工具一目录）
   - 已有的 `list_dir`（name 字段）/ `read_file`（name 字段）同步重命名为 `LS` / `FileRead`，类对应 `LSTool` / `FileReadTool`，并迁移目录
   - `src/llm/` 命名空间下不再保留任何 `Tool` / `tools.*` 相关文件
4. **常量集中**：所有超时、截断、重试上限集中到 `src/tools/utils.ts`（对齐 claude-code 顶层 utils 文件）
5. **e2e 任务通过**：能完成"在一个 demo 仓库内：找出所有 `.ts` 文件中调用 `oldFn` 的位置 → 替换为 `newFn` → 跑 `bun test` 确认通过"
6. **不引入回归**：现有 `LSTool`（原 `list_dir`）/ `FileReadTool`（原 `read_file`）测试全绿

---

## 二、Tool 接口扩展

### 2.1 当前接口（来自 `src/llm/types.ts`，M1 将搬到 `src/Tool.ts`）

```typescript
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ToolInputSchema;
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ) => string | Promise<string>;
}

interface ToolExecutionContext {
  readonly signal: AbortSignal;
}
```

✅ **`AbortSignal` 已经在 context 里**，M1 不需要改 Tool 接口的 execute 签名。

### 2.2 M1 扩展：增加 `requiresApproval` 字段

```typescript
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ToolInputSchema;
  /**
   * 是否需要用户审批后才能执行。M1 仅作为标记埋点，
   * 实际审批逻辑由 M3 权限系统消费。
   * - true: 工具有副作用，未来必须经过审批
   * - false / undefined: 只读工具，永不需要审批
   */
  readonly requiresApproval?: boolean;
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ) => string | Promise<string>;
}
```

| 工具类（`Tool.name` 字段） | requiresApproval |
|---|---|
| `LSTool`（`LS`） / `FileReadTool`（`FileRead`） / `GrepTool`（`Grep`） / `GlobTool`（`Glob`） | `false`（不写） |
| `BashTool`（`Bash`） / `FileWriteTool`（`FileWrite`） / `FileEditTool`（`FileEdit`） | `true` |

### 2.3 与 claude-code Tool 接口的差异声明

claude-code 的 `src/Tool.ts`（约 700 行）使用 Zod schema、依赖 MCP SDK、引用 React UI 类型、含 `CanUseToolFn` 钩子等大量字段。**M1 不复刻这些**，仅保留 `name` / `description` / `input_schema` / `execute` / `requiresApproval` 五个核心字段。

理由：

- nova-code 当前没有 Zod / MCP SDK / Ink，强行引入接口空壳会形成假接口
- claude-code 的 Tool 接口是多年演进的累积结果，应在对应能力 milestone 引入时再扩展
- M1 接口字段是 claude-code Tool 接口的真子集，未来扩展不会破坏向后兼容

各能力的 milestone 归属：

| claude-code Tool 接口字段 | nova-code 引入时机 |
|---|---|
| Zod-based input_schema | M9 Skills 系统（一并引入 Zod） |
| MCP 相关字段 | M8 MCP 客户端 |
| React UI 渲染（progress / result message） | M13 TUI |
| `validateInput` / `canUse` / `userFacingName` | M3 权限系统 |
| `prompt.ts` 文件（每工具一个） | M5 init / system prompt 体系化时引入 |

### 2.4 ToolExecutionContext 不动

`signal` 已经存在，5 个新工具全部消费它实现 abort。

未来 M3 会扩展 context（加 `cwd` / `logger` / `userApprover` 等），但**不在 M1 做**，避免设计未验证就先扩接口。

---

## 三、目录结构调整（对齐 claude-code）

### 3.1 当前（M0 历史包袱）

```
src/
├── llm/
│   ├── types.ts        # 含 Tool 接口
│   ├── tools.ts        # 所有工具 + builtinTools + findTool + 常量
│   ├── query.ts
│   ├── client.ts
│   ├── errors.ts
│   └── ...
├── cli.ts
├── commands.ts
├── config/
└── index.ts
```

### 3.2 M1 调整后（对齐 claude-code 顶层布局）

```
src/
├── Tool.ts             # ⬅️ 从 src/llm/types.ts 中的 Tool 接口搬来（对齐 claude-code/src/Tool.ts）
├── tools.ts            # ⬅️ 工具注册表（builtinTools + findTool），对齐 claude-code/src/tools.ts
├── tools/              # ⬅️ 工具实现目录，对齐 claude-code/src/tools/
│   ├── utils.ts        # 共享 helper + 常量集中（对齐 claude-code/src/tools/utils.ts）：
│   │                   #   - requireStringField / describeError
│   │                   #   - validateCwd / isIgnoredPath / sanitizePathForMessage
│   │                   #   - TOOL_LIMITS / SEARCH_IGNORE_DIRS 常量
│   ├── LSTool/
│   │   └── LSTool.ts           # ⬅️ 原 list_dir，重命名 + 迁移
│   ├── FileReadTool/
│   │   └── FileReadTool.ts     # ⬅️ 原 read_file，重命名 + 迁移
│   ├── BashTool/
│   │   └── BashTool.ts         # 🆕
│   ├── FileWriteTool/
│   │   └── FileWriteTool.ts    # 🆕
│   ├── FileEditTool/
│   │   └── FileEditTool.ts     # 🆕
│   ├── GrepTool/
│   │   └── GrepTool.ts         # 🆕
│   └── GlobTool/
│       └── GlobTool.ts         # 🆕
│
├── llm/                # 仅保留与 transport/protocol 强相关的内容
│   ├── client.ts       # Anthropic SDK 包装
│   ├── query.ts        # runAgentLoop（M1.5 重命名为 src/QueryEngine.ts）
│   ├── errors.ts       # 错误类
│   └── ...
├── commands.ts
├── config/
├── cli.ts
└── index.ts
```

测试镜像同样结构：`src/tools/<ToolName>/<ToolName>.test.ts`、`src/tools/utils.test.ts`。

### 3.3 与 claude-code 的差异声明

| 维度 | claude-code | nova-code M1 | 理由 |
|---|---|---|---|
| 工具主文件后缀 | `.tsx`（每工具有 React/Ink UI 渲染） | `.ts` | nova-code M1 还没有 Ink；M13 引入 TUI 时再补 `UI.tsx` |
| 每工具目录的辅助文件 | claude-code 的 BashTool 目录有 18 个辅助文件（`bashSecurity.ts` / `pathValidation.ts` / `prompt.ts` 等） | M1 阶段每工具仅 1 个主文件 | 渐进引入。如 `prompt.ts` 在 M5 体系化 system prompt 时拆出；`bashSecurity.ts` 在 M3 权限系统时按需拆出 |
| `src/tools/shared/` 目录 | claude-code 用于跨工具协调状态（`gitOperationTracking.ts` / `spawnMultiAgent.ts`） | **M1 不创建** `shared/` 目录 | M1 阶段无跨工具协调需求；helper 全部放 `src/tools/utils.ts`（与 claude-code 同位） |
| `LSTool` 工具 | claude-code **没有** | nova-code 保留（M0 已有 `list_dir`，重命名为 `LS`） | 见 roadmap §7.0 允许的偏离 #1 |

> **`Tool.name` 命名**已在 v2.2 评审中对齐 claude-code 的 PascalCase（无后缀，如 `Bash` / `FileWrite` / `FileEdit` / `Grep` / `Glob` / `LS` / `FileRead`），不再列为偏离。

### 3.4 兼容性 / 迁移路径

- 外部仅通过 `import { builtinTools, findTool } from "./tools.js"`（顶层）访问 → 调用方需更新一次 import 路径
- 现有 `src/llm/tools.test.ts` 拆为 `src/tools/LSTool/LSTool.test.ts` + `src/tools/FileReadTool/FileReadTool.test.ts`
- 删除原 `src/llm/tools.ts`、原 `src/llm/types.ts` 中的 `Tool` 接口定义（不留 re-export shim，避免长期遗留）

### 3.5 `findTool` 未命中时的 agent loop 行为（v2.2 评审 · 测试 Issue #4 已存在能力登记）

> 此小节仅为登记现有能力，避免后续 reviewer / 实施者把 "findTool 未命中处理" 误判为 M1 gap。**M1 不需要新增任何代码或测试。**

- **现有实现位置**：`src/llm/query.ts` 的 `executeOneTool` 函数（M1 步骤 1 命名空间清理后会迁到 `src/query.ts`）
- **现有行为**：findTool 返回 undefined 时抛 `ToolExecutionError(use.name, "Unknown tool '<name>'. Available tools: <list>.")`，被 `query.ts` 的工具执行循环捕获 → 转为 `tool_result` block 且 `is_error=true`，回灌给 LLM 让其在下一轮自行纠正
- **现有测试位置**：`src/llm/query.test.ts:322` 用例 `"模型调用未注册工具 → is_error=true 并列出可用工具"`，断言错误消息含 `"Unknown tool"` 且列出可用工具
- **M1 后续动作**：步骤 1 命名空间清理时同步把 `query.test.ts` 中工具名 `"nonexistent"` 测试**保留不动**，仅迁移路径；不新增用例
- 原 `src/llm/types.ts` 若仅剩 `NovaMessage` / `AgentEvent` 等非 Tool 类型，**M1 范围内保留**；M1.5 随 `QueryEngine.ts` 重命名一起评估搬迁

---

## 四、五个新工具详细设计

### 4.1 `BashTool`（name: `bash`）— 执行 shell 命令

#### 入参 schema

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Shell command to execute. Runs in /bin/sh -c." },
    "timeout_ms": { "type": "number", "description": "Optional timeout in milliseconds. Default 30000, max 300000." },
    "cwd": { "type": "string", "description": "Optional working directory (absolute or relative to process cwd). Defaults to process cwd." }
  },
  "required": ["command"]
}
```

#### 行为

- 用 Node `child_process.spawn("/bin/sh", ["-c", command])`，**不**用 `exec`（避免 shell 注入溢出）
- stdout / stderr 合并捕获，按字节截断
- `timeout_ms` 到时 → 发送 SIGTERM，500ms 后 SIGKILL，**SIGKILL 后再等 1000ms（detach grace window）**：
  - 若子进程在该窗口内退出（绝大多数情况）→ 正常返回带 `[killed: timeout after Xms]` 的 result
  - 若子进程仍 alive（罕见，如卡在 D state 不可中断系统调用 / 内核僵尸）→ **detach + 立即返回**，结果前缀加 `[warning] child likely zombie, pid=<N>, detached after SIGKILL`，agent loop 不被阻塞
- `signal.aborted` → 同样 SIGTERM → SIGKILL → 1000ms detach grace 流程
- 退出码非 0 不抛异常，作为 `tool_result` 内容返回（让模型自己判断是否需要纠正）

> **detach 语义**：使用 `child.unref()` 释放 event loop 引用；不再 `await` child 的 `exit` 事件，立即 resolve 包装 Promise。被 detach 的子进程后续若由 OS 回收，stdout/stderr 已断开 pipe，输出丢失也无妨（result 已包含截至 detach 时刻的全部输出）。这是 M1 对"工具不能拖死 agent"的硬性保证。

#### `cwd` 参数校验规则

| 情况 | 行为 |
|---|---|
| 未传 | 使用 `process.cwd()` |
| 传入相对路径 | `path.resolve(process.cwd(), cwd)` 解析为绝对路径 |
| 传入绝对路径 | 直接使用 |
| 解析后路径不存在 | 抛 `ToolExecutionError("bash", "cwd does not exist: <path>")` |
| 解析后路径不是目录 | 抛 `ToolExecutionError("bash", "cwd is not a directory: <path>")` |
| 解析后无读权限（`fs.access(R_OK)` 失败） | 抛 `ToolExecutionError("bash", "cwd not accessible: <path>")` |

> M1 **不限制** cwd 的范围（例如不禁止 `/etc`）。"路径白名单/越界拦截"是 M3 权限系统的职责，M1 仅做"参数有效性"校验。

#### 输出格式

```
$ <command>
<stdout + stderr 合并，按时间序>
[exit code: <N>] [duration: <ms>ms]
```

输出超 `BASH_MAX_OUTPUT_BYTES`（见 §5）时：
- 前 50% 保留头部、后 50% 保留尾部，中间插入 `... (truncated N bytes) ...`

#### 输出格式可解析性约束（v2.2 评审 · 架构 Issue #3 增补）

> **背景**：M1 范围内 `Tool.execute` 签名保持 `=> string | Promise<string>`（见 §2.1），不扩展为结构化对象。模型必须从 BashTool 输出的纯文本中提取退出码 / 耗时等关键信号；为保证模型能稳定解析，输出格式必须满足下列**严格约束**，并由单测固化。

**约束 1：尾行必须严格匹配以下正则**

```
/^\[exit code: (-?\d+)\] \[duration: (\d+)ms\]$/m
```

- exit code 允许负数（如 SIGTERM 导致的 -15）
- duration 仅整数毫秒，不带单位变体（不允许 "1.2s"、"1200 ms"）
- **整行**作为 stdout/stderr 的最后一行单独占据，不与 command 输出混排

**约束 2：首行必须严格匹配 `^\$ ` 前缀**

```
/^\$ (.+)$/m
```

- 即使 command 内容包含换行，也按原样追加（不转义），但首行 `$ ` 前缀仅出现一次

**约束 3：截断标记必须严格匹配**

```
/^\.\.\. \(truncated (\d+) bytes\) \.\.\.$/m
```

- 字节数为整数，没有逗号分隔符（不写 "1,024"）

**约束 4：软警告前缀（命中时）必须严格匹配**

```
/^\[warning\] command matched soft-warn patterns: (.+)$/m
```

- 多个 pattern 用 `, ` 分隔（半角逗号 + 单空格）
- 仅出现一次，且必须是输出的第一行（在 `$ <command>` 之前）

**约束 5：超时标记必须严格匹配**

```
/\[killed: timeout after (\d+)ms\]/
```

- 出现位置：在 `[exit code: ...]` 行之前的输出尾部，独立成行

**约束 6：detach 兜底标记（v2.2 评审 · 测试 Issue #2 增补）必须严格匹配**

```
/^\[warning\] child likely zombie, pid=(\d+), detached after SIGKILL$/m
```

- 出现位置：在 `[killed: timeout after Xms]` 行之前，独立成行
- pid 为整数，无前导 0
- 仅在 SIGKILL 后 1000ms detach grace window 仍未退出时出现；正常 timeout（SIGKILL 内退出）**不出现此行**

#### 单测要求（落地约束）

`src/tools/BashTool/BashTool.test.ts` 必须包含以下"输出格式可解析性"测试组（独立 `describe` 块）：

| 测试用例 | 断言（regex） |
|---|---|
| `parses exit code 0` | `/\[exit code: 0\] \[duration: \d+ms\]/.test(output)` 为 true |
| `parses non-zero exit code` | 同上模式，捕获组 1 === "1"（或具体 N） |
| `parses negative exit code (SIGTERM)` | 命令被 SIGTERM 杀掉时，exit code 捕获组能匹配 `/-\d+/` |
| `command line prefix present exactly once` | 输出中 `^\$ ` 出现次数 === 1 |
| `truncation marker matches strict pattern` | 强制超出 `BASH_MAX_OUTPUT_BYTES`，断言 `/\.\.\. \(truncated \d+ bytes\) \.\.\./` 匹配 |
| `soft-warn prefix at first line, single occurrence` | 命中软警告时，输出第一行匹配 `/^\[warning\]/`，且全文 `[warning]` 出现次数 === 1 |
| `timeout marker present and parseable` | 触发 timeout，断言 `/\[killed: timeout after \d+ms\]/` 匹配，**且** `[exit code: ...]` 行仍存在 |
| `detach grace window: zombie warning emitted`（v2.2 评审 · 测试 Issue #2 增补） | 用 `bash -c 'trap "" TERM KILL; sleep 30'` 模拟无法被信号杀死的子进程（trap 忽略信号），设 `timeout_ms=200` 触发 timeout 流程；断言 ① 输出含 `/\[warning\] child likely zombie, pid=\d+, detached after SIGKILL/`、② 输出仍含 `[killed: timeout after 200ms]`、③ Promise 在 ~1700ms 内 resolve（200 timeout + 500 SIGTERM grace + 1000 SIGKILL grace ± 容差），**不**永久挂起 |

> **后续迁移路径**：M1.5 / M3 评估扩 `Tool.execute` 接口为 `=> ToolResult | Promise<ToolResult>`（其中 `ToolResult = string | { content: string; metadata?: Record<string, unknown> }`）时，BashTool 升级为返回 `{ content, metadata: { exitCode, durationMs, killedByTimeout, softWarnings } }`，**模型协议层零感知**（content 字段保留当前文本格式，metadata 是新增信息）。当前严格的输出格式约束确保升级时模型仍可向下兼容旧 session 的纯文本 result。

#### 安全约束（M1 最小集）

> 完整策略 M3 做。M1 只做"灾难拦截"，避免误触毁电脑。

**硬黑名单**（匹配即拒绝执行，返回错误）：

```typescript
const BANNED_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[rRfF]+\s+)+\/(\s|$)/,         // rm -rf /
  /\brm\s+(-[rRfF]+\s+)+\/\*/,             // rm -rf /*
  /\bdd\s+.*\bof=\/dev\/(sd|nvme|disk)/,   // dd of=/dev/sda
  /\bmkfs\b/,                              // mkfs.*
  />\s*\/dev\/sd[a-z]/,                    // > /dev/sda
  /:\(\)\{\s*:\|:&\s*\};:/,                // fork bomb
];
```

**软警告**（M1 不拦截，命中后将警告信息**作为 bash 工具 result 内容的前缀**返回给模型）：

- 包含 `curl ... | sh`、`wget ... | bash`
- 包含 `sudo`
- 包含网络写操作（`scp`、`rsync` 到远程）

输出格式（仅命中软警告时）：

```
[warning] command matched soft-warn patterns: <pattern1>, <pattern2>
$ <command>
<stdout + stderr>
[exit code: <N>] [duration: <ms>ms]
```

**与硬黑名单的交互顺序**（明确优先级避免实施时歧义）：

1. 先匹配硬黑名单：命中即抛 `ToolExecutionError`，**命令完全不执行**，不再检查软警告
2. 软警告匹配仅在硬黑名单未命中时进行，命中则按上方格式在 result 前缀加 `[warning]` 行
3. 同一命令命中多条软警告 pattern 时，全部模式名追加在同一行（用 `, ` 分隔）

**为什么不走 debug sink**：当前 `DebugSink` 接口是 `src/commands.ts` 的私有实现，未导出；工具拿到的 `ToolExecutionContext` 仅含 `signal`，无 logger 通道。让工具访问 debug sink 需扩 context 接口（违反 §2.3 "M1 不动 context"），或引入全局 logger（违反 §十"不与 M1.5 transport 层日志方案冲突"）。

**为什么把警告嵌入 result**：

- 模型本身能看到这条警告，对"自我纠正"也有信号价值（比单纯写日志更有用）
- 完全在工具内部实现，不跨模块
- 不污染 stdout/stderr（result 走 SSE 回传链路）
- M3 升级权限系统时再把"嵌入 result"重构为"调用 userApprover"，迁移面仅限本工具一个文件

#### 错误处理

| 场景 | 行为 |
|---|---|
| 命中硬黑名单 | 抛 `ToolExecutionError("Bash", "Command rejected by safety filter: <pattern>")` |
| spawn 失败（找不到 sh） | 抛 `ToolExecutionError`，附原始错误 |
| timeout（SIGKILL 内退出） | 返回正常 result，内容含 `[killed: timeout after Xms]` |
| timeout + zombie（SIGKILL 后 1000ms 仍 alive） | 返回正常 result，前缀加 `[warning] child likely zombie, pid=<N>, detached after SIGKILL` + 末尾 `[killed: timeout after Xms]`，**不抛错** |
| abort（用户中断，正常被杀） | 抛 `AbortError`，由 agent loop 上层处理 |
| abort + zombie（SIGKILL 后 1000ms 仍 alive） | 抛 `AbortError`，并在 error.message 后缀附 `(zombie pid=<N> detached)`，agent loop 仍可正常清理 |
| 退出码非 0 | 不抛，正常返回带 exit code 的输出 |

---

### 4.2 `FileWriteTool`（name: `write_file`）— 创建新文件

#### 入参 schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute or relative path. File must NOT already exist." },
    "content": { "type": "string", "description": "Full file content (UTF-8)." }
  },
  "required": ["path", "content"]
}
```

#### 行为

- **若文件已存在 → 抛错**（必须用 `edit_file`）。这是和 claude-code 的 FileWriteTool 一致的设计：避免模型用 write 误覆盖
- 父目录不存在 → 自动 `mkdir -p`
- 写入用 `fs.writeFile(path, content, { encoding: "utf8", flag: "wx" })`，`wx` 标志保证存在则失败
- `content` 字节数 > `WRITE_MAX_FILE_BYTES`（见 §5） → 抛错
- abort 检查：写入前检查 `signal.aborted`，写入中不可中断（写一个文件极快，无收益）

#### 输出格式

```
Created <path> (<N> bytes, <M> lines)
```

#### 错误处理

| 场景 | 行为 |
|---|---|
| 文件已存在 | `ToolExecutionError`：建议用 edit_file |
| content 超大 | `ToolExecutionError`：建议拆多个文件或用 bash heredoc |
| 父目录创建失败（权限） | 透传错误，附 path |
| 路径包含 `..` 越界 | **有意延后**至 M3：路径白名单/沙箱越界拦截属于权限系统统一职责。M1→M3 之间没有任何兜底机制，写权工具裸跑；为此 README 必须显式标注 "M1 阶段写权工具不做路径越界检查，请勿在生产敏感目录下运行 nova-code"，且 §十一风险表已记录"误改用户文件"为已知风险 |

---

### 4.3 `FileEditTool`（name: `edit_file`）— 字符串替换式编辑

> 这是整个 M1 最关键的工具。claude-code 的 FileEditTool 经过反复验证：**强制 old_string 在文件中唯一匹配**，是模型可靠编辑的关键约束。

#### 入参 schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to existing file." },
    "old_string": { "type": "string", "description": "Exact text to replace. Must appear EXACTLY ONCE in the file." },
    "new_string": { "type": "string", "description": "Replacement text. Empty string deletes." },
    "replace_all": { "type": "boolean", "description": "If true, replace every occurrence. Default false." }
  },
  "required": ["path", "old_string", "new_string"]
}
```

#### 行为

**前置校验**（任一失败立即抛 `ToolExecutionError`，不读文件、不写）：

- a. `path` 必须是非空字符串（由 `requireStringField` 处理）
- b. `old_string` = `new_string` → 抛"no-op edit"错误（**无论 `replace_all` 取值**，避免无意义写入）
- c. `path` 对应文件不存在 → 抛错并建议改用 `write_file`
- d. `fs.stat(path).size > EDIT_MAX_FILE_BYTES` → 抛错（不允许编辑超大文件）

**主流程**：

1. 读取文件全文（UTF-8）
2. 计算 `old_string` 出现次数 N：
   - `replace_all = false`（默认）：N 必须 = 1
     - N = 0 → 抛错（错误信息见错误处理表）
     - N > 1 → 抛错（要求扩大 `old_string` 上下文使其唯一，或改用 `replace_all=true`）
   - `replace_all = true`：N 必须 ≥ 1
     - N = 0 → 抛错（同 N=0 错误信息）
3. 执行替换
4. 检查 `signal.aborted`：若已 abort，跳过写入直接抛 `AbortError`
5. 写回（原子写，详见下方"原子写与并发"）
6. 返回变更摘要

#### 原子写与并发

**原子写实现**：

- 临时文件名 = `<path>.<pid>.<random6hex>.tmp`，例如 `src/foo.ts.12345.a1b2c3.tmp`
  - 包含 pid 与随机后缀避免同进程内并发冲突
  - 同目录写 tmp 保证 `rename` 是同 mount 原子操作
- 流程：`fs.writeFile(tmpPath, newContent, { encoding: "utf8", flag: "wx" })` → `fs.rename(tmpPath, path)`
- `rename` 失败 → 清理 tmp 文件，抛错
- `writeFile` 失败 → 清理 tmp 文件（若已生成），抛错

**并发安全**（M1 范围）：

| 场景 | 行为 |
|---|---|
| 同一文件被两次 edit_file 并发调用 | 两次都正常完成（rename 顺序不定），**最终内容只反映后完成的那次**。M1 不做文件锁 |
| 文件在读取与写入之间被外部进程修改 | M1 **不检测**，按读到的旧内容计算 diff、写新内容。可能覆盖外部修改 |
| 临时文件残留（如进程被 SIGKILL） | M1 不做启动时清理，仅依赖 tmp 文件名带 pid 避免冲突 |

> 真实业务里 agent loop 的工具调用是**串行**的（一次 turn 内 LLM 不会同时发起两个 edit_file）。M1 不引入文件锁是有意为之 —— 锁会引入新的死锁/超时复杂度，留待 Phase 3 主线 A "工具并行调度" 时统一设计。

**持久化保证（v2.2 评审 · 性能 Issue #1 明确）**：

- **M1 不调用 `fsync(tmp)` 与 `fsync(parent_dir)`**。理由：
  - agent loop 工具调用语境是"编辑后立刻 grep / bash 验证"，断电/kernel panic 不在主线场景内
  - fsync 会让 SSD 上的写延迟放大 2-3x、HDD 上 ~10x，影响 e2e 任务的整体响应
  - claude-code 同样未做 fsync（仅依赖 OS page cache + rename 的 inode 原子性）
- **后果**：极端情况下（rename 后立刻断电），文件 inode 已切换但 page cache 未刷盘 → 重启后看到空文件 / 旧内容。M1 范围内**视为可接受**
- **未来评估**：如果 M5+ 引入"长时间运行任务的崩溃恢复"，再统一评估 fsync 是否值得加（届时可能需要 WAL 而非简单 fsync，整体设计变化大）

#### 输出格式

**单次替换**（`replace_all=false` 或仅命中 1 处）：

```
Edited <path>
- Replacements: 1
- Lines before: <X> → after: <Y>
- Diff:
  @@ line <L> @@
  - <removed line 1>
  - <removed line 2>
  + <added line 1>
  + <added line 2>
```

**多次替换**（`replace_all=true` 命中 N>1 处）：

```
Edited <path>
- Replacements: <N>
- Lines before: <X> → after: <Y>
- Diff (first 3 hunks):
  @@ line <L1> @@
  - ...
  + ...
  @@ line <L2> @@
  - ...
  + ...
  @@ line <L3> @@
  - ...
  + ...
  ... (<N-3> more hunks omitted)
```

**Diff 规则**：

- 每处替换展示 1 个 hunk，每个 hunk 含变更前后**各 2 行 context**
- 多次替换最多展示前 3 个 hunk，超出用 `... (X more hunks omitted)` 结尾
- 不展示完整 diff（避免消耗 token）
- 行号 `<L>` 指**变更前**的起始行号（1-indexed）

**行数统计口径**（"Lines before / after" 与上方错误信息中的行数计算）：

- 按 `\n` 字符切分，**结尾换行不算单独一行**：`"a\nb\n".split("\n").length - 1 = 2` 行；`"a\nb".split("\n").length = 2` 行（与多数编辑器/`wc -l` 行为一致）
- 空文件 = 0 行
- 仅包含 `\n` 的文件 = 1 行（一个空行后的行尾换行）
- 实现：`content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0) + (content.endsWith("\n") ? 0 : 1)` —— 即"完整行 + 尾部不完整行"
- 单测必须覆盖：空文件 / 单行无换行 / 单行有换行 / 多行混合

#### 错误处理

| 场景 | 触发时机 | 错误信息 |
|---|---|---|
| 文件不存在 | 前置校验 c | `"file not found: <path>. To create a new file, use write_file."` |
| `old_string` = `new_string` | 前置校验 b | `"no-op edit: old_string equals new_string. Nothing to do."`（无论 replace_all 取值） |
| 文件大小 > `EDIT_MAX_FILE_BYTES` | 前置校验 d | `"file too large to edit: <X> bytes (limit <LIMIT> bytes). Use bash with sed/awk for very large files."` |
| `old_string` 出现 0 次（任一 replace_all） | 主流程 2 | `"old_string not found in <path>. The file has <N> lines and <M> bytes."`。**M1 不做 fuzzy 匹配建议**（与 §十一风险表保持一致：fuzzy 仅在 edit_file 失败率 > 30% 时引入），仅返回基础统计帮助模型判断是否搞错了文件 |
| `old_string` 出现多次但 replace_all=false | 主流程 2 | `"old_string found <N> times in <path>. Either expand old_string with surrounding context to make it unique, or set replace_all=true."` |
| abort 信号已触发 | 主流程 4 | 抛 `AbortError`，由 agent loop 上层处理 |

#### 关键约束

- **不支持基于行号编辑**：行号编辑模型容易算错；字符串替换更稳健
- **不支持正则**：模型倾向用过度宽松的正则导致误伤
- **写入是原子的**：通过 `tmp + rename` 实现，避免中途崩溃留半截文件

---

### 4.4 `GrepTool`（name: `grep`）— 文件内容检索

#### 入参 schema

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Regex pattern (JavaScript regex syntax)." },
    "path": { "type": "string", "description": "Directory to search. Defaults to cwd." },
    "include": { "type": "string", "description": "Glob filter for filenames (e.g. '*.ts'). Optional." },
    "case_sensitive": { "type": "boolean", "description": "Default false." }
  },
  "required": ["pattern"]
}
```

#### 行为

- **优先用 ripgrep**：进程级缓存检测（见下），存在则 `spawn("rg", [...])`
- **fallback 到纯 Node 实现**：`fs.readdir` 递归 + 正则匹配（仅在 `rg` 不可用时**或 ripgrep 运行时异常时**，见下"ripgrep 运行时异常降级"）
- 自动跳过：`.git`、`node_modules`、`dist`、`build`、`.venv` 等（完整列表见 `src/tools/utils.ts` 的 `SEARCH_IGNORE_DIRS`）。过滤语义同 §4.5 glob 工具：路径任一段精确匹配即跳过，与 glob 共用 `src/tools/utils.ts` 中的 `isIgnoredPath` helper
- 匹配数超 `GREP_MAX_MATCHES`（见 §5） → 截断并提示
- 单行长度超 `GREP_MAX_LINE_BYTES` → 截断该行

#### ripgrep 运行时异常降级（v2.2 评审 · 测试 Issue #3 增补）

ripgrep 退出码语义（来自 `man rg`）：

| exitCode | 语义 | 处理 |
|---|---|---|
| `0` | 有匹配 | 解析 stdout 返回结果 |
| `1` | 无匹配（正常） | 返回 `No matches found.` |
| **其他**（含 `2`、负数、信号杀死等） | **ripgrep 自身异常**（非法参数 / OOM / 段错误 / SIGPIPE / 内部 panic） | **立即降级走 Node fallback 实现重试一次**；同次调用内只降级一次，fallback 仍失败则按 fallback 自身错误抛 |

降级流程：

1. spawn rg → wait exit
2. 若 exitCode ∈ {0, 1} → 走正常路径
3. 否则 → 记 debug（含 stderr 前 200 字节、exitCode），**不抛错**，立即调用同模块内的 `runNodeGrep(args)` 重新执行
4. fallback 结果作为本次工具调用的最终结果返回；**不**因为"先尝试过 rg"而修改输出格式
5. **不**修改 `ripgrepPath` 缓存（一次异常不代表 rg 永久不可用，下次调用仍优先尝试 rg；缓存只由 `detectRipgrep()` 的"binary 不存在"场景设置为 null）

#### ripgrep 检测策略

```typescript
// 进程内 lazy + cached：首次调用时检测一次，结果缓存到模块级变量
let ripgrepPath: string | null | undefined = undefined;

async function detectRipgrep(): Promise<string | null> {
  if (ripgrepPath !== undefined) return ripgrepPath;
  // 用 spawn("rg", ["--version"]) 检测，0 退出码视为可用
  // 检测失败（任何错误） → null
  // 检测期间不抛错，永远 resolve
  ripgrepPath = await tryDetect();
  return ripgrepPath;
}
```

- **检测时机**：每个 nova-code 进程的首次 `grep` 调用
- **缓存范围**：进程级（不写磁盘）
- **检测失败**：永久回退到 Node 实现，不再重试（避免每次调用都付检测开销）
- **测试钩子**：暴露 `_resetRipgrepCache()` 仅供单测，避免测试间状态污染

#### 输出格式

```
<file>:<line>: <matching content>
<file>:<line>: <matching content>
...
[N matches in M files]
```

匹配数超限时追加 `[truncated, showing first K of N matches]`。

#### 错误处理

| 场景 | 行为 |
|---|---|
| 正则非法 | `ToolExecutionError`：附正则解析错误 |
| 路径不存在 | `ToolExecutionError` |
| ripgrep binary 不可用（detectRipgrep 返回 null） | 走 Node fallback，缓存永久标记不可用 |
| ripgrep 启动成功但运行时异常退出（exitCode ∉ {0, 1}） | **降级走 Node fallback 重试一次**（见上"ripgrep 运行时异常降级"），不抛错；fallback 仍异常则按 fallback 错误抛 |
| 0 匹配 | 不抛错，返回 `No matches found.` |

---

### 4.5 `GlobTool`（name: `glob`）— 文件名通配匹配

#### 入参 schema

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Glob pattern (e.g. 'src/**/*.ts'). Uses Bun.Glob syntax (a subset of standard glob)." },
    "cwd": { "type": "string", "description": "Base directory. Defaults to process cwd." }
  },
  "required": ["pattern"]
}
```

#### 行为

- 使用 **`Bun.Glob`**（Bun 1.3+ 内置，nova-code package.json 已声明 `bun >=1.3.0`）
  - 调用方式：`new Bun.Glob(pattern).scan({ cwd, absolute: false, onlyFiles: true })`
  - 返回 AsyncIterable<string>，逐项消费便于早期截断
- 默认 ignore：通过手动过滤 `SEARCH_IGNORE_DIRS` 实现（`Bun.Glob` 自身不支持 ignore 选项）
  - **过滤语义**：将相对路径按 `path.sep` 切分为段，若**任一段**精确等于 `SEARCH_IGNORE_DIRS` 中的某项，则跳过该路径
  - 例：`SEARCH_IGNORE_DIRS=[".git", "node_modules"]` 时，`src/.git/HEAD` 跳过、`docs/git-notes.md` 不跳过、`a/node_modules/b/c.ts` 跳过、`my-node_modules/x.ts` 不跳过
  - 实现位置：`src/tools/utils.ts` 中的 `isIgnoredPath(relPath, ignoreSet)` helper，GrepTool 与 GlobTool 共用
- 结果数超 `GLOB_MAX_RESULTS` → 截断（提前 break 迭代，省 IO）
- 按 mtime 倒序返回（最近修改优先），便于模型聚焦活跃文件
  - 实现：先收集到 `GLOB_MAX_RESULTS` 个候选 → `fs.stat` 拿 mtime → 排序

#### 输出格式

```
<path1>
<path2>
...
[N matches]
```

#### 错误处理

| 场景 | 行为 |
|---|---|
| 非法 glob 语法 | `ToolExecutionError`，附 Bun.Glob 抛出的错误 |
| `cwd` 不存在 / 不是目录 | `ToolExecutionError`（复用 `src/tools/utils.ts` 中的 `validateCwd(input)` helper，与 BashTool 共享） |
| 0 匹配 | 不抛错，返回 `No files match.` |

#### 为什么不用 `fast-glob`

| 维度 | `Bun.Glob`（选用） | `fast-glob`（备选） |
|---|---|---|
| 依赖 | 0（运行时内置） | 引入 npm 包 + 间接依赖 |
| 编译产物体积 | 不变 | `bun build --compile` 产物增大约 200KB+ |
| 启动时间 | 不变（已加载） | 多一次 require 解析 |
| 功能 | 基础 glob + AsyncIterable | 完整 glob + 同步 + ignore 选项 + stats |
| ignore 选项 | ❌ 需手动过滤 | ✅ 原生支持 |

**结论**：M1 选 `Bun.Glob`。手动过滤 ignore 的代价（几行迭代器逻辑）远小于引入第三方依赖的体积/维护成本。如果未来 `Bun.Glob` 性能或功能不足，再迁移到 `fast-glob`，迁移面仅限本工具一个文件。

#### 依赖

- **不**新增 npm 依赖
- 仅依赖 Bun 1.3+ 内置 API（package.json 已声明 `engines.bun >=1.3.0`）

---

## 五、常量集中（`src/tools/utils.ts`）

> 位置选择：claude-code 的 `src/tools/utils.ts` 是顶层共享 utils 文件（已确认存在）。nova-code M1 把常量与 helper 都放这里，避免新建 `limits.ts` 偏离 claude-code 结构。

```typescript
// src/tools/utils.ts

export const TOOL_LIMITS = {
  // 已有
  maxFileBytes: 1024 * 1024,                    // FileReadTool 单文件读取上限
  maxDirEntries: 500,                           // LSTool 条目上限

  // BashTool
  bashDefaultTimeoutMs: 30_000,
  bashMaxTimeoutMs: 300_000,
  bashMaxOutputBytes: 256 * 1024,               // 256KB

  // FileWriteTool
  writeMaxFileBytes: 5 * 1024 * 1024,           // 5MB（远大于 read 上限，因为模型可能生成大配置文件）

  // FileEditTool
  editMaxFileBytes: 1024 * 1024,                // 1MB（与读对齐）

  // GrepTool
  grepMaxMatches: 200,
  grepMaxLineBytes: 2_000,

  // GlobTool
  globMaxResults: 500,
} as const;

export const SEARCH_IGNORE_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".venv",
  ".next",
  ".nova-code",   // 自家配置/日志目录
];

// 共享 helpers（同文件内导出）：
// - requireStringField / describeError
// - validateCwd / isIgnoredPath / sanitizePathForMessage
```

---

## 六、错误体系扩展

`src/llm/errors.ts` 已有的相关错误类（M1 范围内不动；M1.5 跟随 transport 层重构再评估搬迁到 `src/services/api/errors.ts`）：

| 错误类 | 用途 | 设计稿引用位置 |
|---|---|---|
| `ToolExecutionError(toolName, message, { cause })` | 所有工具的业务错误 | §4.1~4.5 各工具错误处理表 |
| `AbortError(message?)` | 用户中断（`signal.aborted`） | §4.1 bash abort 一栏 |

**M1 不新增错误类**。所有新工具遵循以下消息约束：

- **面向模型**：错误消息要让模型能自我纠正。例：`"file not found: <path>. Did you mean <suggestion>?"`，而非 `"ENOENT"`
- **路径脱敏的适用范围**：
  - **错误消息**（`ToolExecutionError` 的 message 字段）：**必须**走 `sanitizePathForMessage`，将以 `os.homedir()` 开头的绝对路径替换为 `~/...`
  - **工具正常输出**（如 `Edited <path>` / `Created <path>` / bash 的 `$ <command>` 回显）：**同样必须**走 `sanitizePathForMessage`，统一对外接口。理由：模型看到的所有路径风格保持一致，避免它把 `/Users/xxx/...` 和 `~/...` 当成两个不同路径
  - **bash 命令的 stdout/stderr 内容**：**不脱敏**（用户运行的命令是什么输出就是什么；脱敏会破坏 cat / grep 等工具的输出语义）
- **敏感内容泄露的边界（M1 范围）**：
  - **不实现内容过滤**。bash 跑 `cat /etc/passwd` / `env`、read_file 读 `~/.ssh/id_rsa` 都会原样回传给模型
  - 这是**有意决定**：M1 范围内由路径白名单 / 命令前确认两个机制阻止泄露，但都属于 M3 权限系统的职责
  - README 必须显式标注："M1 阶段工具不做敏感文件 / 命令输出过滤，请勿在含密钥 / 密码的环境运行 nova-code"
  - §十一风险表已记录"模型自主调 bash 读敏感文件"为已知风险

> `sanitizePathForMessage(absolutePath)` 实现位置：`src/tools/utils.ts`。所有工具构造 message / 输出 path 时统一调用。

---

## 七、与 agent loop 的交互

`runAgentLoop` 现有逻辑**完全不变**：

- 工具调用走 `findTool` → `tool.execute(input, { signal })`
- 抛错 → 包成 `tool_result` 带 `is_error: true`
- 正常返回 → 字符串作为 `tool_result.content`

**M1 不消费 `requiresApproval`**：该字段仅作为标记存在，由 M3 增加的 `userApprover` middleware 消费。

---

## 八、测试计划

### 8.1 单测覆盖（每工具一文件，路径 `src/tools/<ToolName>/<ToolName>.test.ts`）

| 工具 | 测试文件 | 关键测试用例 |
|---|---|---|
| `BashTool` | `src/tools/BashTool/BashTool.test.ts` | 正常退出 / 非 0 退出 / timeout / abort / 黑名单拒绝 / 软警告嵌入 result / stdout+stderr 合并 / 输出截断 / cwd 不存在 / cwd 非目录 / cwd 生效 / **zombie detach grace（v2.2 评审 · 测试 Issue #2 增补）** |
| `FileWriteTool` | `src/tools/FileWriteTool/FileWriteTool.test.ts` | 正常创建 / 文件已存在拒绝 / 父目录自动创建 / 超大内容拒绝 / abort 前检查 |
| `FileEditTool` | `src/tools/FileEditTool/FileEditTool.test.ts` | 单次替换 / replace_all 多 hunk diff 输出 / old_string 不存在 / 多次匹配但未开 replace_all / 文件不存在 / 文件超大拒绝 / 原子写（模拟 rename 失败时 tmp 已清理） / abort 前检查 / 行数统计口径（空文件 / 单行无换行 / 单行有换行 / 多行混合） |
| `GrepTool` | `src/tools/GrepTool/GrepTool.test.ts` | 有匹配 / 无匹配 / include 过滤 / case_sensitive 切换 / 黑名单目录跳过（含 `src/.git/HEAD` 跳过、`docs/git-notes.md` 不跳过等边界） / ripgrep 与 fallback 一致性 / 正则非法 / abort / **ripgrep 运行时异常降级（v2.2 评审 · 测试 Issue #3 增补）：mock spawn 让 rg 退出码为 2 / -1 / 137 (SIGKILL)，分别断言：① 工具不抛错 ② 实际执行了 fallback（通过监视 `runNodeGrep` 调用计数 === 1 验证）③ 输出与"直接走 fallback"路径完全一致 ④ `ripgrepPath` 缓存未被改写为 null** |
| `GlobTool` | `src/tools/GlobTool/GlobTool.test.ts` | 基本 glob / 无匹配 / 黑名单跳过（同上边界） / mtime 排序 / cwd 不存在 / cwd 非目录 / 非法 glob 语法 / abort |
| **`src/tools/utils.ts` helpers** | `src/tools/utils.test.ts` | `validateCwd` 全部分支 / `isIgnoredPath` 边界（任一段精确匹配语义） / `sanitizePathForMessage`（`$HOME` 替换为 `~`） |
| 已有工具迁移测试 | `src/tools/LSTool/LSTool.test.ts`、`src/tools/FileReadTool/FileReadTool.test.ts` | 从原 `src/llm/tools.test.ts` 拆分 + 路径调整，行为不变 |
| **工具命名一致性 smoke test**（v2.2 评审 · 代码质量 Issue #1 增补） | `src/tools.test.ts` | 遍历 `builtinTools`，对每个工具断言下列约束（防止新增工具时类名 / `Tool.name` 字段拼写漂移）：① `tool.name` 非空字符串、② `tool.name` 仅含 `[A-Za-z0-9]`（PascalCase 字面量校验，禁止 snake_case 误回归）、③ 通过维护一份 `BUILTIN_TOOLS_NAMING: ReadonlyArray<{ tool: Tool; expectedName: string }>` 静态映射表交叉校验 `tool.name === expectedName`、④ `builtinTools` 中 `tool.name` 全集无重复（用 `Set` 验证 `size === length`）。M8 (MCP) 引入动态工具时，本测试为静态注册表的"内置工具集"专用兜底 |

### 8.2 集成测试（mock LLM + 真工具）

延续仓库现有约定（**所有测试都是 `src/**/*.test.ts`，由 `bun test` 直接发现**）：

- 新增 `src/tools/integration.test.ts` 作为工具间集成测试（位于 `src/tools/` 顶层，与 claude-code `src/tools/utils.ts` 同目录层级）

#### Mock server 扩展方式

当前 `scripts/mock-anthropic.ts` 的剧本是硬编码枚举 `ScenarioEnum { SIMPLE, TOOL }`，`?scenario=tool` URL 参数选择剧本。当前 `buildScenarioEvents(scenario, body)` 对 TOOL 剧本的轮次判断是**两轮硬编码 if/else**：首次请求返回 `tool_use(list_dir)`，如果 `body.messages` 已包含 tool_result 则返回文本 + end_turn。

> mock 中现有的工具名 `list_dir` 在 M1 重命名后改为 `LS`（见 §3.3 / §一表格），实施步骤 1 同步改完。

M1 新增 `edit-loop` 剧本（4 轮）的具体改动：

1. **扩枚举**：`ScenarioEnum` 增加 `EDIT_LOOP = "edit-loop"`，`parseScenario` 增加分支
2. **沿用同样的"数 tool_result 次数"模式判断当前轮次**：在 `buildScenarioEvents` 中为 EDIT_LOOP 增加分支，统计 `body.messages` 中 tool_result content block 出现次数 N，N=0/1/2 分别返回剧本第 1/2/3 轮，N≥3 返回第 4 轮（文本 + end_turn）
3. **复用 `composeToolUseTurn` / `composeTextOnlyTurn`** 已有 helper 拼装事件
4. **不需要新 endpoint** / **不需要参数化 schema** / **不需要引入"通用 turnIndex 框架"**（那是 mock 自身的重构，与 M1 无关）

> 这是对当前 mock 的"最小增量扩展"。如果未来发现剧本 if/else 链过长难维护，由 mock 自身重构（不在 M1 设计稿范围）。

#### 剧本内容

| 轮次 | mock 返回（工具 name 字段值） | 集成测试断言 |
|---|---|---|
| 1 | `tool_use`: `Grep(pattern="oldFn", path=<tmpDir>)` | `GrepTool` 被调用，返回非空匹配 |
| 2 | `tool_use`: `FileEdit(path=<file>, old_string="oldFn", new_string="newFn", replace_all=true)` | `FileEditTool` 被调用，文件内容已更新 |
| 3 | `tool_use`: `Bash(command="echo verified")` | `BashTool` 被调用，stdout 含 "verified"（**避免在 bun test 内嵌套 bun test 的递归风险**） |
| 4 | `text`: `"Done. All occurrences replaced."` + `end_turn` | agent loop 正常结束，stopReason=end_turn |

> **mock 现状同步改动**：`scripts/mock-anthropic.ts` 当前 `?scenario=tool` 剧本里 `composeToolUseTurn` 调用使用了 `name: "list_dir"` —— 实施步骤 1（结构对齐）必须把它同步改为 `"LS"`，否则 mock 集成测试会断在工具名查找环节。

#### 测试结构

- 启动 mock server（参照已有 `src/llm/query.test.ts` 模式：`Bun.serve` + 随机端口）
- 用 `os.tmpdir()` 创建临时工作目录 + 写入若干含 `oldFn` 的 fixture 文件，结束清理
- 调用 `runAgentLoop`，订阅 `AgentEvent` 流
- 断言：事件序列符合预期 / 文件最终状态正确 / 未触发任何安全过滤

### 8.3 e2e 验收（不引入新测试框架）

仓库当前**没有**独立的 `tests/e2e/` 目录。M1 **不**新建该目录，复用 `bun test` 体系：

- 在 `src/cli.test.ts` 中新增一个 e2e 测试用例 `m1-edit-task`：
  1. 启动 mock server（端口随机）
  2. `os.tmpdir()` 准备 fixture：3 个含 `oldFn` 调用的 `.ts` 文件
  3. 用 `Bun.spawn` 拉起 `bin/nova-code.ts ask "..."`，环境变量指向 mock server
  4. 断言：进程退出码 0 + 三个文件都已被改 + stdout 含 "Done" 等
  5. 清理 tmp 目录与 mock server

- **不**引入 shell 脚本 / Playwright / 其它 e2e 框架，保持工具链单一

> 原设计稿中的 `tests/e2e/m1-edit-task.sh` 路径是凭空假设的，实际仓库结构不允许。已修正为复用 `bun test`。

---

## 九、实施顺序

按"先对齐结构、再加新能力、风险高的先做"原则：

1. **结构对齐 #1**（无新功能，纯搬迁，对齐 claude-code 顶层布局）
   - 把 `src/llm/types.ts` 中的 `Tool` 接口搬到 `src/Tool.ts`
   - 创建 `src/tools/utils.ts`（含 `TOOL_LIMITS` / `SEARCH_IGNORE_DIRS` / 全部 helper）
   - 创建 `src/tools.ts` 注册表（builtinTools + findTool）
   - 把原 `src/llm/tools.ts` 中的 `list_dir` / `read_file` 实现拆迁到 `src/tools/LSTool/LSTool.ts` / `src/tools/FileReadTool/FileReadTool.ts`
   - 测试同步迁移：`src/tools/LSTool/LSTool.test.ts` / `src/tools/FileReadTool/FileReadTool.test.ts` / `src/tools/utils.test.ts`
   - 删除 `src/llm/tools.ts` + 清理 `src/llm/types.ts` 中的 Tool 相关定义（不留 re-export shim）
   - 更新所有调用方 import 路径
   - **commit & 验证**：现有测试全绿、`ask "hello"` mock 跑通

2. **`Tool` 接口加 `requiresApproval` 字段**（无消费方，仅声明）
   - 更新 `src/Tool.ts`
   - `LSTool` / `FileReadTool` 不变（默认 undefined ≡ false）
   - **commit & 验证**

3. **`BashTool`**（最复杂、最危险，先把它做对）
   - 创建 `src/tools/BashTool/BashTool.ts` + `src/tools/BashTool/BashTool.test.ts`
   - 在 `src/tools.ts` 注册
   - 跑 mock 集成测试
   - **commit & 验证**

4. **`FileWriteTool` + `FileEditTool`**（两者紧密相关，一起做）
   - 创建对应目录与文件
   - 写完后做"用 FileWriteTool 创建新文件 → FileEditTool 修改它"的小集成测试
   - **commit & 验证**

5. **`GrepTool` + `GlobTool`**（相对简单）
   - 注意 GrepTool 的 ripgrep / fallback 双路径要分别测
   - **commit & 验证**

6. **e2e 验收**（§8.3）
   - 通过即关闭 M1
   - **打 git tag**（具体版本号待 roadmap.md 的"版本号策略"决策后确定，**M1 设计稿不预设版本号**；当前仓库 package.json 为 `0.0.1`，M1 完成后由发布人按届时确定的策略命名）

> 步骤 1 是 M1 引入的额外结构对齐工作（v2.1 新增），独立 commit。**这是一次性的命名空间清理**，做完后所有后续 milestone 都能直接落到 `src/<ModuleName>/` 顶层，不再有"先翻译再落地"的开销。

---

## 十、与 M1.5 的交接

M1 实施过程中，遇到下列情况**不解决，标记 `// REFACTOR M1.5` 注释**留给重构窗口：

- **`BashTool` 中出现 retry 需求**（如网络命令偶发失败）→ M1.5 的 transport 层（`src/services/api/`）统一做
- **工具调用层的横切关注点**（agent loop 调用工具时的统一日志、超时兜底、abort 传播规范化）→ M1.5 在 transport 层解决；M1 范围内每工具自管自己的 abort
- **agent loop 调用工具的并发调度**（多个 tool_use 并行执行）→ M1.5 + Phase 3 主线 A 一起规划
- **debug sink 多 session 切分** → M1.5 单独做
- **`src/llm/query.ts` 重命名为 `src/QueryEngine.ts`**（剩余的命名空间清理）→ M1.5 随 transport 层抽取一起做（已记入 roadmap M1.5 milestone）

> ⚠️ `src/tools/utils.ts` 中的 helper（`validateCwd` / `isIgnoredPath` / `sanitizePathForMessage` / `requireStringField`）属于"工具内部共享逻辑"，与 claude-code 的 `src/tools/utils.ts` 同位同职责，**M1.5 不动它们**。

---

## 十一、风险与回退

| 风险 | 触发信号 | 回退方案 |
|---|---|---|
| bash 黑名单太严，常用命令被拒 | 自用时连续 3 次以上误拦 | 黑名单改为 warning + 询问（提前进入 M3 部分逻辑） |
| edit_file 唯一匹配约束太严，模型频繁失败 | 单次任务中 edit_file 失败率 > 30% | 引入 fuzzy match 自动补 context 提示 |
| ripgrep 与 Node fallback 行为不一致 | 单测发现差异 | 统一以 ripgrep 输出为准，fallback 用相同正则规范化 |
| `Bun.Glob` 在某些 glob 模式下行为与预期不符（如已知的 bind-mount 路径问题） | glob 工具单测出现非预期失败 / 真实使用中匹配数明显少于 `find` | 切换到 `fast-glob` 作为可选依赖（仅 glob 工具一文件迁移）；package.json 加入 optionalDependencies |
| write_file/edit_file 误改用户文件 | 自用中出现 1 次以上误改 | 立即提前启动 M3 的"工具调用前用户确认"最小子集（仅实现"每次写权工具调用前 stdin 询问 y/N"，不做 allowlist 持久化）。这是 M3 的最小切片，不等 M3 完整方案 |
| 模型自主调 bash / read_file 读敏感文件（如 `~/.ssh/id_rsa`、`/etc/passwd`、`env`） | 自用 / 早期试用中出现 1 次以上 | 同上"提前启动 M3 最小子集"；同时在 README 显式标注 M1 阶段不做敏感文件 / 命令输出过滤的限制（与 §六敏感内容泄露边界呼应） |

---

## 十二、版本历史

- **v2.2**（2026-05-01）：plan-eng-review 评审落地：
  - **架构 Issue #1**：`Tool.name` 字段从 snake_case 改为 PascalCase（无 Tool 后缀），完全对齐 claude-code：`bash` → `Bash` / `write_file` → `FileWrite` / `edit_file` → `FileEdit` / `grep` → `Grep` / `glob` → `Glob` / `list_dir` → `LS` / `read_file` → `FileRead`。理由：`Tool.name` 进入用户对话历史 / debug 日志，是单向门决策，M1 上线前必须对齐。同步改动：§一表格、§1.2/§1.3/§2.2 工具名引用、§3.3 删除"snake_case 偏离"条目并加 v2.2 评审 note、§8.2 mock 剧本表 + 新增"mock 现状同步改动"提示
  - **架构 Issue #3**：BashTool 输出格式从"约定式描述"升级为"严格正则可解析性约束"。§4.1 增补 5 条 regex 约束（尾行 exit code/duration、首行 `$ ` 前缀、截断标记、软警告前缀、超时标记）+ 7 个单测用例（独立 `describe` 块）。理由：M1 范围内 `Tool.execute` 不扩接口，模型从纯字符串提取退出码必须有稳定解析协议；同时为 M1.5/M3 升级为 `ToolResult` 结构化对象铺路（content 字段格式不变，metadata 增量加）
  - **代码质量 Issue #1**：在 §8.1 测试矩阵新增"工具命名一致性 smoke test"行，文件 `src/tools.test.ts`，对 `builtinTools` 实施 4 条断言（非空 / PascalCase 字面量 / 静态映射表交叉校验 / name 全集无重复）。理由：类名 `BashTool` 与 `Tool.name === "Bash"` 之间的"去掉 Tool 后缀"约定无编译期保障，新增工具拼写漂移可能要到 prod 才暴露；smoke test 永久兜底
  - **测试 Issue #2 (critical gap #1)**：BashTool 增加 SIGKILL 后 1000ms detach grace window —— §4.1 行为段落明确"超时三段式：SIGTERM (500ms) → SIGKILL (1000ms) → detach + 立即返回"；增补输出格式约束 6（zombie warning 行 regex）；§4.1 错误处理表新增 timeout+zombie / abort+zombie 两行；§8.1 BashTool 测试矩阵新增 zombie detach grace 用例（用 `trap "" TERM KILL` 模拟无法被信号杀死的子进程）。理由：原设计 SIGKILL 后无兜底，子进程卡 D state 会 silent 挂死 agent loop，是 critical gap，必须由工具层主动放弃等待
  - **测试 Issue #3 (中等 gap #2)**：GrepTool 明确 ripgrep 退出码语义 `{0:有匹配, 1:无匹配}`，**其他退出码视为 rg 自身异常即降级 Node fallback 重试一次**。§4.4 新增"ripgrep 运行时异常降级"段（含退出码表 + 5 步降级流程 + "缓存不被异常覆盖"语义）；§4.4 错误处理表拆分"binary 不可用 vs 运行时异常"两行；§8.1 GrepTool 测试矩阵新增 4 条断言用例（mock spawn 让 rg 返回 exitCode=2/-1/137）。理由：原设计只覆盖"binary 不存在"，rg 启动后 OOM/段错误会 silent 抛 unhandled error
  - **测试 Issue #4 (无 gap，登记现有能力)**：新增 §3.5 "findTool 未命中时的 agent loop 行为"段。M1 不新增代码，仅登记 `src/llm/query.ts:307-312` 现有处理（抛 `ToolExecutionError` + 列可用工具）+ `src/llm/query.test.ts:322` 现有测试用例，避免后续 reviewer / 实施者重复评估
  - **性能 Issue #1 (无新增代码，明确取舍)**：§4.3 原子写段落新增"持久化保证"小节，**显式声明 M1 不调用 fsync**。理由：agent loop 工具调用断电不在主线场景内，fsync 让 SSD 写延迟放大 2-3x，与 claude-code 同步默认行为一致；M5+ 引入崩溃恢复时再统一评估。避免后续实施者凭直觉补 fsync 引入性能回退
- **v2.1**（2026-05-01）：响应 roadmap §7.0 "与 claude-code 结构对齐"原则，全文重构：
  - §一 工具表加类名列与 claude-code 对应路径（PascalCase + Tool 后缀：BashTool / FileWriteTool / FileEditTool / GrepTool / GlobTool）
  - §1.3 DoD 重写"目录结构对齐"项与"常量集中位置"
  - §二新增 §2.3 "与 claude-code Tool 接口的差异声明"，列出 5 类未引入字段及其归属 milestone
  - §三完全重写：当前布局 / 调整后布局都用 src/ 顶层（src/Tool.ts + src/tools.ts + src/tools/<ToolName>/<ToolName>.ts）；新增 §3.3 "与 claude-code 的差异声明"表（.tsx 后缀 / 辅助文件 / shared/ 目录 / Tool.name 命名 / LSTool 5 项偏离及理由）
  - §五 常量位置从 `tools/limits.ts` 改为 `src/tools/utils.ts`（claude-code 同位）
  - §六 sanitizePathForMessage 实现位置改为 `src/tools/utils.ts`
  - §8.1 测试文件路径全部改为 `src/tools/<ToolName>/<ToolName>.test.ts` + 新增已有工具迁移测试条目
  - §8.2 集成测试位置改为 `src/tools/integration.test.ts`，剧本表加"工具类名"对应
  - §九实施顺序新增"步骤 1 结构对齐"作为 M1 第一个 commit
  - §十交接段新增"src/llm/query.ts → src/QueryEngine.ts"重命名归属 M1.5
- **v2.0**（2026-05-01）：十次自检后修复 — §六错误体系扩展段重构：明确路径脱敏的适用范围（错误消息 + 工具正常输出 path 都脱敏，bash stdout 不脱敏），并把"禁止泄露"空头承诺改为"M1 不实现内容过滤 + 由 M3 接管 + README 警示 + 风险表登记"的完整闭环；§十一风险表新增"模型自主调 bash / read_file 读敏感文件"一行（修复 §六对风险表的悬空引用）
- **v1.9**（2026-05-01）：九次自检后修复 — §4.3 错误处理表"fuzzy 匹配建议"撤回（与 §十一风险表"M1 不做 fuzzy"自相矛盾，且未提供算法依据 / 当前仓库无 levenshtein 实现），改为返回"行数 + 字节数"基础统计；行为流程同步移除 fuzzy 引用；新增 `edit_file` 输出格式的"行数统计口径"段，明确空文件 / 尾部换行等边界的计算规则与单测要求
- **v1.8**（2026-05-01）：八次自检后修复 `edit_file` 行为/错误对齐 — §4.3 行为拆分为"前置校验 a-d + 主流程 1-6"两段，明确前置失败不读文件、abort 检查的精确时机（写入前）；错误处理表改为三列（场景 / 触发时机 / 错误信息全文），覆盖原表遗漏的"replace_all=true 但 0 匹配"和"abort"两个场景，并明确"old=new no-op"无论 replace_all 取值都拒绝（消除歧义）
- **v1.7**（2026-05-01）：七次自检后修复 — §8.2 mock 扩展方式撤回"composeEditLoopTurn(turnIndex)"假设（mock 现状是两轮硬编码 if/else，没有 turnIndex 抽象），改为"沿用 TOOL 剧本的'数 tool_result 次数'模式扩展到 4 轮"，明确不引入通用 turnIndex 框架；§4.1 补全硬黑名单与软警告的交互顺序（避免"sudo rm -rf /"这类同时命中两类规则的歧义）
- **v1.6**（2026-05-01）：六次自检后修复关键架构假设 — §4.1 软警告"经 debug sink 记录"撤回（debug sink 是 `commands.ts` 私有，工具无法访问），改为"作为 bash result 内容前缀返回"（含选型理由）；§8.2 mock 剧本扩展方式具体化（之前只写"新增剧本 edit-loop"未说怎么改 mock；现明确"扩 ScenarioEnum 枚举 + 新增 composeEditLoopTurn 函数"，对照真实 mock 源码结构）
- **v1.5**（2026-05-01）：五次自检后修复 — §3.2 `shared.ts` 注释补全 v1.3/v1.4 新增的 helper（validateCwd / isIgnoredPath / sanitizePathForMessage）；§4.2 删除"M3 接管前的全局确认兜底"假设（M1→M3 之间确实没有兜底，改为 README 警示 + 风险表记录）；§十一删除"`--require-confirm` flag"假设（M1 不存在该 flag），改为"提前启动 M3 最小子集（stdin y/N 询问）"
- **v1.4**（2026-05-01）：四次自检后修复 — §六错误约束的"$HOME 路径"歧义改为明确的"以 homedir 开头则替换为 ~"规则并指定 `sanitizePathForMessage` helper；§九实施步骤 6 的"tag v0.2.0"撤回（与 roadmap 待决策的版本号策略对齐）；§十"M1.5 抽更高层"自相矛盾段删除并明确 shared.ts helper 不动；§8.1 测试矩阵补全 cwd / abort / 多 hunk diff 等本轮新增的边界 + 新增 shared.ts 的独立测试条目
- **v1.3**（2026-05-01）：三次自检后修复 — `bash` 软警告"日志记录"明确落到 debug sink（避免假设有通用 logger）；`edit_file` Diff 输出格式补全多次替换场景（含 hunk 限制规则）；`grep`/`glob` 的 `SEARCH_IGNORE_DIRS` 过滤语义明确为"路径任一段精确匹配"，统一到 `tools/shared.ts:isIgnoredPath` helper
- **v1.2**（2026-05-01）：二次自检后修复遗漏 — 真正落实参照路径修正（v1.1 漏改的位置）；明确 cwd 校验 helper 位置为 `tools/shared.ts:validateCwd`；§4.2 路径越界一栏改为"有意延后"措辞避免歧义；§十一风险表删除已废弃的 fast-glob 风险条，改为 Bun.Glob 真实风险（含已知 bind-mount issue）+ 回退路径
- **v1.1**（2026-05-01）：自检后补强 — `bash` 的 `cwd` 校验规则；`edit_file` 的原子写细节与并发取舍；`grep` ripgrep 检测的进程级缓存策略；`glob` 改用 `Bun.Glob` 而非引入 `fast-glob`（含选型对比）；测试计划修正为复用 `bun test`（仓库现状无 `tests/e2e/`）
- **v1.0**（2026-05-01）：初版设计稿
