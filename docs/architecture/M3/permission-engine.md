# 02 · Permission Engine —— 七步流水线

> 本篇拆解 [`src/services/permissions/permissionEngine.ts`](../../../src/services/permissions/permissionEngine.ts) 的 `evaluatePermission()`：每一步的判定条件、输入输出、设计权衡。
>
> Engine 是 M3 的"大脑"，但它**不做任何 IO**：所有 mode / rules / cwd 都由 QueryEngine 注入。这种"纯函数 + 有状态外壳"的分层是 M3 设计哲学第 12 条。

## 1. 接口形状

```typescript
function evaluatePermission(input: PermissionEvaluationInput): PermissionEvaluationResult
```

```typescript
interface PermissionEvaluationInput {
  readonly mode: PermissionMode;                          // 当前会话模式
  readonly toolName: string;                              // Tool.name
  readonly requiresApproval: boolean;                     // 由调用方从 Tool.requiresApproval 取出
  readonly input: unknown;                                // 工具原始入参（engine 自己提取 command/path）
  readonly rules: readonly PermissionRuleWithSource[];    // 三层合并后列表
  readonly cwd: string;                                   // 用于 file glob 相对化
}

interface PermissionEvaluationResult {
  readonly decision: PermissionDecision;                  // allow | deny | ask
  readonly reason: string;                                // 给 UI / 日志的人类可读说明
  readonly matchedRule?: PermissionRuleWithSource;        // 命中的规则（用于审计）
  readonly denyPatternName?: string;                      // 命中 DENY_PATTERNS 时的名字
}
```

四个值得点出的设计取舍：

- **`requiresApproval` 由调用方传入**而不是 engine 自己读 `Tool` 对象 —— engine 不依赖 `Tool.ts`，单测无须搬整套工具栈。
- **`rules` 是合并后的扁平列表**而不是三个数组 —— 让 engine 内部循环"按 source 分层"的逻辑显式存在于 engine 里，不分散到调用方。
- **`cwd` 必填**而不是默认 `process.cwd()` —— 强制调用方意识到"file glob 是相对哪个目录算的"，避免在测试里被 `process.cwd()` 偷偷影响。
- **`reason` 永远非空**：engine 在每条 return 路径都写 reason，UI 只需要原样展示。

## 2. 七步流水线总览

```
                    ┌────────────────────────┐
toolName = Bash?    │ Step 1 DENY_PATTERNS   │ ── 命中 → deny（denyPatternName）
                    │  （无视 mode）          │
                    └────────────┬───────────┘
                                 │ 未命中 / 非 Bash
                                 ↓
                    ┌────────────────────────┐
                    │ Step 2 bypassPermissions│ ── mode=bypass → allow
                    └────────────┬───────────┘
                                 │
                                 ↓
                    ┌────────────────────────┐
                    │ Step 3 deny 规则        │ ── 任一 source 命中 → deny
                    │  （三层不分优先级）      │
                    └────────────┬───────────┘
                                 │
                                 ↓
                    ┌────────────────────────┐
                    │ Step 4 allow / ask 规则 │ ── session > project > global
                    │  按 source 三层遍历     │      首条命中 behavior=allow→allow
                    │                         │                   behavior=ask  →ask
                    └────────────┬───────────┘
                                 │
                                 ↓
                    ┌────────────────────────┐
                    │ Step 5 acceptEdits      │ ── mode=acceptEdits ∧ FileWrite/FileEdit → allow
                    └────────────┬───────────┘
                                 │
                                 ↓
                    ┌────────────────────────┐
                    │ Step 6 requiresApproval │ ── true → ask
                    └────────────┬───────────┘
                                 │
                                 ↓
                    ┌────────────────────────┐
                    │ Step 7 默认             │ ── allow（只读工具兜底）
                    └────────────────────────┘
```

七步顺序是不可调换的。下文逐步精读。

## 3. Step 1 —— DENY_PATTERNS（仅 Bash）

代码：[`dangerousPatterns.ts`](../../../src/services/permissions/dangerousPatterns.ts)

```typescript
export const DENY_PATTERNS: ReadonlyArray<{ name; pattern: RegExp }> = [
  { name: "rm-rf-root",         pattern: /\brm\s+(-[rRfF]+\s+)+\/(\s|$)/ },
  { name: "rm-rf-root-glob",    pattern: /\brm\s+(-[rRfF]+\s+)+\/\*/ },
  { name: "rm-rf-home",         pattern: /\brm\s+(-[rRfF]+\s+)+~(\/|\s|$)/ },
  { name: "dd-to-disk",         pattern: /\bdd\s+.*\bof=\/dev\/(sd|nvme|disk)/ },
  { name: "mkfs",               pattern: /\bmkfs\b/ },
  { name: "redirect-to-disk",   pattern: />\s*\/dev\/sd[a-z]/ },
  { name: "fork-bomb",          pattern: /:\(\)\{\s*:\|:&\s*\};:/ },
  { name: "curl-pipe-shell",    pattern: /\b(curl|wget)\s+[^|]*\|\s*(sh|bash|zsh)\b/ },
  { name: "sudo",               pattern: /\bsudo\b/ },
];
```

**关键性质**：

- **只对 Bash 工具生效**。FileWrite/FileEdit 不过这一步——它们的拦截走 deny 规则 + ask 兜底。理由：DENY_PATTERNS 的语义是"shell 灾难性命令"，对 file 写入工具不适用。
- **bypassPermissions 也不能绕过**。源码顺序是 Step 1 在 Step 2 之前，并非笔误。这是 M3 设计哲学第 11 条"深度防御优于单层拦截"的直接体现：即便用户主动 `--dangerously-skip-permissions`，engine 仍然拦下 `rm -rf /`。
- **与 `BashTool/HARD_BANNED_PATTERNS` 形成两道防线**。`BashTool.execute()` 会在真正跑命令前再校一次。两份清单内容对齐，但代码独立部署 —— 任一层失效不会让灾难命令落地。
- **`sudo` 升级为 deny**。设计稿（`docs/design/M3-permissions.md` §一）明确说明：`sudo` 在 BashTool 侧只是 soft warn，但权限层升级为硬 deny；用户真要 sudo，需先显式写 allow 规则。

**未收录的"代码执行入口"**：`node` / `python` / `bun` 这类没收录。claude-code 用启发式 classifier 处理，nova-code M3 不做。考虑迁移到 deny 规则用户自决。

## 4. Step 2 —— bypassPermissions

```typescript
if (mode === "bypassPermissions") {
  return { decision: "allow", reason: "bypassPermissions mode" };
}
```

只跳过 Step 3-7，不能跳过 Step 1。这一步存在的本质是给 `--dangerously-skip-permissions` flag 一个落点：用户明确接受一切风险后，engine 不再询问任何工具，只剩 DENY_PATTERNS 兜底。

## 5. Step 3 —— deny 规则（三层不分优先级）

```typescript
for (const entry of rules) {
  if (entry.rule.behavior !== "deny") continue;
  if (!matchRule(entry.rule, toolName, toolInput, cwd)) continue;
  return { decision: "deny", reason: `blocked by ${entry.source} deny rule`, matchedRule: entry };
}
```

**为什么不按 source 排序**？因为 deny 是"安全从严"的强声明：用户在任何一层加了 deny，都不应被另一层的 allow 暗中覆盖。这是 M3 设计哲学第 13 条。

**遍历顺序无意义**：reduce 顺序不影响结果（任意命中即返回）。源码里的 `for (const entry of rules)` 单层循环就够了。

**配合 deny 规则的实际用法**：用户可在 `~/.nova-code/permissions.json` 写：

```json
{ "version": 1, "rules": [
  { "toolName": "Bash", "ruleContent": "git push:*", "behavior": "deny" }
] }
```

之后任何 `git push` / `git push -f` 都被这一步直接拦下，不会到 Step 4-7。

## 6. Step 4 —— allow / ask 规则（按 source 三层）

```typescript
const SOURCE_ORDER: readonly PermissionRuleSource[] = ["session", "project", "global"];
for (const source of SOURCE_ORDER) {
  for (const entry of rules) {
    if (entry.source !== source) continue;
    if (entry.rule.behavior === "deny") continue; // 已在 Step 3
    if (!matchRule(entry.rule, toolName, toolInput, cwd)) continue;
    return {
      decision: entry.rule.behavior, // "allow" | "ask"
      reason: `matched by ${source} ${entry.rule.behavior} rule`,
      matchedRule: entry,
    };
  }
}
```

**两层嵌套循环的效果**：先在 session 内按列表顺序遍历找到第一条命中的非 deny 规则；只有 session 全空或全没命中，才下到 project；project 也无果，才下到 global。"上层覆盖下层"。

**ask 规则的妙用**：用户希望某只读工具（如 `Bash:ls -la /etc`）也强制审批 → 加一条 `behavior: "ask"` 规则。Step 4 命中 ask → engine 直接 return `decision: "ask"`，不再过 Step 5/6/7。**这正是 ask 规则与"requiresApproval=true"语义不同的地方**：requiresApproval 是工具自身声明，而 ask 规则是用户对单条/单类调用的细粒度强制。

**与 claude-code 的差异**：
- claude-code 把多 source 的 allow 规则一次性合并、再按 deny/allow 分类匹配；nova-code 按 source 显式分层，源码长但更可读。
- claude-code 不允许 ask 规则覆盖 requiresApproval=false；nova-code 允许 —— 给"只读但用户偏要被询问"的场景留出口。

## 7. Step 5 —— acceptEdits（仅 FileWrite / FileEdit）

```typescript
if (mode === "acceptEdits" && isFileWriteToolName(toolName)) {
  return { decision: "allow", reason: "acceptEdits mode: file edits auto-approved" };
}
```

**ask 命令的默认模式就是 acceptEdits**（见 [`runAskWithLLM.ts`](../../../src/commands/AskCommand/runAskWithLLM.ts) §6 的 `permissionMode`）。理由：常见的 "headless 跑一次让模型生成代码" 场景里，FileWrite/FileEdit 自动放行能避免 `headless auto-deny` 让任务空跑一遍；Bash 仍受规则约束 + 默认 ask（headless 下退化为 deny）保护。

**只放行 FileWrite/FileEdit 而不放行 Bash**：`isFileWriteToolName` 仅返回这两个工具名 true。模式分级保留了"shell 命令必须明确同意"的安全底线。

## 8. Step 6 —— requiresApproval

```typescript
if (requiresApproval) {
  return { decision: "ask", reason: "tool requires approval" };
}
```

工具自身在定义里声明 `requiresApproval: true`（见 `Tool.ts`）就走这一步。M3 现状：

| 工具 | requiresApproval |
|---|---|
| `Bash` | true |
| `FileWrite` | true |
| `FileEdit` | true |
| `FileRead` / `LS` / `Glob` / `Grep` | false |

只读工具集体 false，由 Step 7 自动 allow，不打扰用户。

## 9. Step 7 —— 默认 allow

```typescript
return { decision: "allow", reason: "tool does not require approval (read-only)" };
```

走到这一步意味着：不是 Bash 灾难命令、不是 bypass、没规则命中、不在 acceptEdits FileEdit 范畴、工具没标 requiresApproval。这种工具默认放行（典型：FileRead / LS / Glob / Grep）。

## 10. 规则匹配分派 —— `matchRule()`

```typescript
function matchRule(rule, toolName, input, cwd): boolean {
  if (rule.toolName !== toolName) return false;

  if (toolName === BASH_TOOL_NAME) {
    const command = extractBashCommand(input);
    if (command === undefined) return false;
    return matchBashRule(rule, command);
  }

  if (isFileWriteToolName(toolName)) {
    const filePath = extractFilePath(input);
    if (filePath === undefined) return false;
    return matchFileRule(rule, filePath, cwd);
  }

  // 其它工具：ruleContent 空 → 匹配整工具；非空 → 不匹配（语义未定义时从严）
  return rule.ruleContent === undefined || rule.ruleContent === "";
}
```

三个分派分支：

| 分支 | 提取字段 | 匹配器 | ruleContent 语义 |
|---|---|---|---|
| Bash | `input.command: string` | `matchBashRule` | `git` / `git:*` / `git status` / `git status:*` |
| FileWrite/FileEdit | `input.path: string` | `matchFileRule` | glob 子集（`*` / `**` / `?` / `[abc]`），相对 cwd 化 |
| 其它 | — | inline | 仅 ruleContent 空时算匹配 |

### 10.1 Bash 匹配语义

详见 [`bashRuleMatcher.ts`](../../../src/services/permissions/bashRuleMatcher.ts)。

```
ruleContent          匹配语义
────────────────     ──────────────────────────────────────────
undefined / ""       匹配所有 Bash 调用
"git"                命令恰好是 `git`（无参数）
"git:*"              命令首 token 是 `git`（不管后续参数）
"git status"         命令恰好是 `git status`（无其它参数）
"git status:*"       命令首两 token 是 `git status`（后续参数不限）
```

简化规则：
1. 不做完整 shlex（不处理引号/转义/变量展开/管道拆解）
2. 只看第一段 pipeline（`|` / `&&` / `;` 之前）的首 1-2 个 token
3. 三级及以上子命令（`git remote add:*`）不支持

设计稿 §十二把"完整 shlex"明确登记为已知风险，推迟到 M3.5。

### 10.2 File 匹配语义

详见 [`fileRuleMatcher.ts`](../../../src/services/permissions/fileRuleMatcher.ts)。

支持的 glob 子集：

| 元字符 | 含义 |
|---|---|
| `*`     | 除 `/` 外任意字符（含空串） |
| `**`    | 任意字符（含 `/`，跨目录） |
| `?`     | 除 `/` 外单字符 |
| `[abc]` / `[!abc]` | 字符类（否定语法 `!`） |

**不支持**：`{a,b}` 大括号展开（用多条 rule 代替）、`!` 前缀否定（用 deny 规则代替）。

**路径相对化**：匹配前先把 input.path 转成相对 cwd 的形式：

```typescript
function normalizePath(filePath, cwd): string {
  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  return rel.split(sep).join("/");   // Windows 兼容
}
```

这让用户写 `docs/**/*.md` 这类规则能命中 LLM 传入的绝对路径调用 `/Users/foo/proj/docs/intro.md`。

**glob → RegExp 编译**：手写转换，不依赖 `Bun.Glob`。理由：`Bun.Glob.match` 行为受 dot/absolute 选项影响，跨版本不稳；本模块"单 path vs 单 pattern"的需求纯字符串匹配就够。

## 11. 错误处理与"不抛错"原则

engine 不会抛任何异常。各分支保证：

| 输入异常 | 处理 |
|---|---|
| `input` 不是 object | extractBashCommand/extractFilePath 返回 undefined → 跳过该规则匹配 → 走后续 step |
| `rule.ruleContent` 是乱码 | matchBashRule/matchFileRule 返回 false（不匹配） → 不阻塞其它规则 |
| `rules` 数组里有重复键 | engine 不去重，按列表顺序匹配 → 匹配语义不变；去重责任在 PermissionStore.upsertRule |

设计原则：**一条坏规则不阻塞整个 session**。规则文件的 schema 校验由 PermissionStore.load 在加载阶段一次性抛 ConfigError；engine 运行时只信任已校验过的数据。

## 12. 单测覆盖矩阵

`permissionEngine.test.ts` 共 14.8KB，按"七步 × 各分支"穷举：

- **Step 1**：每条 DENY_PATTERN 至少一例 + 含 sudo 的反例（即便加了 allow rule 也 deny）
- **Step 2**：bypass × 5 种工具，验证只 DENY_PATTERNS 还能拦
- **Step 3**：单 source deny / 跨 source deny / deny 优先级压过 allow
- **Step 4**：session > project / project > global / 同 source 内顺序
- **Step 5**：acceptEdits × FileWrite ✓ / acceptEdits × Bash ✗
- **Step 6**：requiresApproval=true → ask
- **Step 7**：requiresApproval=false → allow

测试可全部脱离 IO 跑 —— engine 的纯函数本质让"穷举七步分支"成本极低。

## 13. 与 claude-code 的差异速查

| 维度 | claude-code | nova-code M3 |
|---|---|---|
| Mode 档数 | 5（含 plan / dontAsk） | 4（plan 占位未实装） |
| Source 优先级 | allow 与 deny 都按 source 排序 | allow 按 session > project > global；deny 任一层即生效 |
| ask 规则覆盖 requiresApproval=false | 不支持 | 支持 |
| Bash 匹配深度 | 支持多级子命令 | 仅 1-2 级 token（`git` / `git status`） |
| Glob 引擎 | shellac 库 | 手写 glob → RegExp |
| DENY_PATTERNS | 启发式 classifier | 9 条静态正则 |

差异背后的设计动机详见 [`docs/design/M3-permissions.md`](../../design/M3-permissions.md) §三。

---

下一篇：[03 · permission-store.md](./permission-store.md)
