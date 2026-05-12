# 06 · Chat / Ask 集成 —— 入口注入与 `/permissions` 命令

> 本篇拆解 ChatCommand / AskCommand 这两个命令入口在 M3 是如何把权限层"装配"进 QueryEngine 的：
>
> - [`ChatCommand.ts`](../../../src/commands/ChatCommand/ChatCommand.ts) + [`runChatRepl.ts`](../../../src/commands/ChatCommand/runChatRepl.ts)：5 档 REPL Provider + `PermissionModeRef` 可变 ref + `/permissions` 斜杠命令 + `--dangerously-skip-permissions` flag
> - [`runAskWithLLM.ts`](../../../src/commands/AskCommand/runAskWithLLM.ts) + [`parseAskFlags.ts`](../../../src/commands/AskCommand/parseAskFlags.ts)：默认 acceptEdits + Headless Provider + 同 flag 的不同映射
> - [`renderAgentEvent.ts`](../../../src/commands/ChatCommand/renderAgentEvent.ts)：permission_request / permission_decision 的 stderr 渲染

## 1. 装配总览

```
            chat                                       ask
   ┌─────────────────────────────┐         ┌──────────────────────────────┐
   │ ChatCommand.ts              │         │ AskCommand/runAskWithLLM.ts  │
   │  parseChatFlags             │         │  parseAskFlags               │
   │   --dangerously-skip-perm   │         │   --dangerously-skip-perm    │
   │  PermissionStore.load(cwd)  │         │  PermissionStore.load(cwd)   │
   │  permissionMode =           │         │  permissionMode =            │
   │   skip ? "bypass"           │         │   skip ? "bypass"            │
   │        : "default"          │         │        : "acceptEdits"       │
   │  → runChatRepl({...})       │         │  createHeadlessPermProvider  │
   └────────────┬────────────────┘         │  → runAgentLoop({...})       │
                ↓                          └──────────────────────────────┘
   ┌─────────────────────────────┐
   │ runChatRepl.ts              │
   │  createReplPermissionProv() │
   │  PermissionModeRef={get,set}│
   │  → session.sendTurn({       │
   │     permissionMode:         │
   │       modeState.current,    │
   │     permissionStore,        │
   │     permissionProvider,     │
   │     cwd })                  │
   └─────────────────────────────┘
                ↑
   /permissions mode <m>  → permissionModeRef.set(m)
   /permissions list      → 打印 store.getMergedRules()
```

两个命令的关键差异：

| 维度 | chat | ask |
|---|---|---|
| 默认 mode | `default` | `acceptEdits` |
| Provider | REPL 5 档菜单 | Headless auto-deny |
| 模式可切换 | 是（`/permissions mode`） | 否（一次执行） |
| 列规则 | 是（`/permissions list`） | 否 |
| `--dangerously-skip-permissions` 映射 | `bypassPermissions` | `bypassPermissions` |

## 2. ChatCommand.ts —— 入口装配

[`ChatCommand.ts`](../../../src/commands/ChatCommand/ChatCommand.ts) 的 M3 改动主要三处：

**(a) flag 解析**（§31-46）

```typescript
helpText:
  "nova-code chat [--debug] [--debug-pretty] [--resume <id|alias>] [--dangerously-skip-permissions]\n" +
  ...
  "  --dangerously-skip-permissions: 跳过权限询问，仅 DENY_PATTERNS 拦截",

let dangerouslySkipPermissions = false;
// parseChatFlags 中：
dangerouslySkipPermissions = flags.dangerouslySkipPermissions;
```

**(b) 权限 store 加载**（§93-104）

```typescript
let permissionStore: PermissionStore;
try {
  permissionStore = await PermissionStore.load(process.cwd());
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\nchat: ${error.message}`);
    return 1;          // 与 loadConfig 走同样的退出码 1 通道
  }
  throw error;
}
```

`ConfigError` 的拦截位置很重要 —— `PermissionStore.load` 抛错说明 `.nova-code/permissions.json` 文件结构不对，应该让用户**先修文件再启动 REPL**，而不是进入 REPL 才发现权限层不可用。

**(c) 调用 runChatRepl**（§117-126）

```typescript
return await runChatRepl({
  session, config, tools: builtinTools, debugSink,
  llmLogSink: debug ? llmLogSink : undefined,
  permissionStore,
  permissionMode: dangerouslySkipPermissions ? "bypassPermissions" : "default",
});
```

**chat 默认 `default` 模式**：所有 `requiresApproval=true` 的工具都问。这是面向"长对话、用户在线"的场景的安全选择。

## 3. runChatRepl —— Provider 与 ModeRef 的构造

[`runChatRepl.ts`](../../../src/commands/ChatCommand/runChatRepl.ts) §150-167：

```typescript
// PermissionProvider：5 档 REPL 弹窗
const permissionProvider = permissionStore !== undefined
  ? createReplPermissionProvider({ io, readLine })
  : undefined;

// PermissionModeRef：mutable closure
const modeState: { current: PermissionMode } = { current: permissionMode ?? "default" };
const permissionModeRef: PermissionModeRef = {
  get: () => modeState.current,
  set: (m) => { modeState.current = m; },
};
```

**两个设计决策**：

### 3.1 为什么 PermissionModeRef 是 `{ get, set }` 而不是直接传 `mode`

`/permissions mode bypassPermissions` 必须能在运行时改变 mode。如果 mode 是个普通参数，斜杠命令改了它也没用——后面 `session.sendTurn({ permissionMode: mode })` 时仍然读旧值。

用 `PermissionModeRef = { get(): PermissionMode; set(m: PermissionMode): void }` 包成 mutable 闭包：
- 斜杠命令拿 `permissionModeRef.set(m)` 改值
- runChatRepl 主循环每次 sendTurn 前 `permissionMode: modeState.current` 读最新值
- modeState 是单一来源，没有"两份 mode 异步漂移"的问题

这也是 [README.md](./README.md) 设计哲学第 14 条"可运行时切换的 mode 通过可变 ref 传递"的具体落地。

### 3.2 为什么 provider 在 store 缺时也是 undefined

```typescript
const permissionProvider = permissionStore !== undefined
  ? createReplPermissionProvider({ io, readLine })
  : undefined;
```

理由：没 store 时根本不会启用权限系统（QueryEngine 的兼容性矩阵），engine 永远不会决策为 ask，provider 永远不会被调用——构造它纯属浪费。

## 4. SlashContext 增量

[`slash/types.ts`](../../../src/commands/ChatCommand/slash/types.ts) §47-64：

```typescript
export interface PermissionModeRef {
  get(): PermissionMode;
  set(mode: PermissionMode): void;
}

export interface SlashContext {
  readonly session: ChatSession;
  readonly io: SlashIO;
  readonly args: readonly string[];
  // ── M3 新增 ──
  readonly configSource?: ConfigSource;
  readonly permissionStore?: PermissionStore;
  readonly permissionModeRef?: PermissionModeRef;
}
```

斜杠命令（包括 `/permissions`）通过 `SlashContext` 拿到 store 和 modeRef。两个字段都可选——保证不依赖权限系统的命令（如 `/help`）和测试场景不需要构造它们。

`runChatRepl` 装配 SlashContext 时 §216-218：

```typescript
const dispatch = await dispatchSlash(input, {
  session, io: slashIO, args,
  ...(configSource ? { configSource } : {}),
  ...(permissionStore !== undefined ? { permissionStore } : {}),
  permissionModeRef,           // 永远传，保证 /permissions mode 可切换
});
```

`permissionModeRef` 永远传——即使没有 store，用户输入 `/permissions mode` 也得到合理回复（"权限系统未启用"）。

## 5. `/permissions` 斜杠命令

[`slash/permissions.ts`](../../../src/commands/ChatCommand/slash/permissions.ts) 共 109 行，仅两个子命令：

```
/permissions [list]            列出 session/project/global 规则
/permissions mode              显示当前权限模式
/permissions mode <m>          切换模式 (default|acceptEdits|bypassPermissions|plan)
```

### 5.1 `/permissions list`

```typescript
function printRules(io, rules: readonly PermissionRuleWithSource[]): void {
  // 按 source 分组
  for source of ["session","project","global"]:
    print "[<source>] (<count>)"
    if 空: print "  (none)"
    else:
      for { rule } of items:
        content = rule.ruleContent ?? "*"
        print "  <behavior padEnd 5> <toolName> <content>"
}
```

输出示例：

```
[session] (1)
  allow Bash git:*
[project] (2)
  allow FileWrite docs/**/*
  deny  Bash      git push:*
[global] (0)
  (none)
```

`behavior.padEnd(5)` 让 deny / allow / ask 三档对齐，便于用户视觉扫描。

### 5.2 `/permissions mode`

```typescript
const next = args[1];
if (next === undefined || next === "") {
  io.print(`当前模式：${permissionModeRef.get()}\n`);
  return { action: "continue" };
}
if (!isValidMode(next)) {
  io.print(`未知模式 "${next}"。合法值：${VALID_MODES.join(" | ")}\n`);
  return { action: "continue" };
}
const prev = permissionModeRef.get();
permissionModeRef.set(next);
io.print(`权限模式：${prev} → ${next}\n`);
```

**输出包含 prev → next**：让用户对模式切换有明确反馈，避免"我以为我已经在 acceptEdits 了，怎么还问"。

### 5.3 故意不实现的两个子命令

```typescript
// 设计选择：
// - 不支持 `/permissions add`：规则的增加走交互式 5 档菜单更安全直观；
//   手工 add 容易写错 rule 语法
// - 不支持 `/permissions remove`：第一版保持最小表面积
```

**`/permissions add` 不做的理由**：用户手输 `/permissions add Bash "git push:*" deny` 这种命令容易把 ruleContent 语法记错（是 `git:*` 还是 `git :*`？是不是要 quote？）。让升级走 5 档菜单 + 升级（`buildPersistedRule` 自动构造正确语法），出错面小。

**`/permissions remove` 不做的理由**：第一版最小表面积。用户要删规则可以直接编辑 `.nova-code/permissions.json`，重启 REPL 生效。M3.5 / M4 可加。

## 6. AskCommand 集成

[`runAskWithLLM.ts`](../../../src/commands/AskCommand/runAskWithLLM.ts) §63-95：

```typescript
const config = await loadConfig();
const permissionStore = await PermissionStore.load(process.cwd());
const permissionProvider = createHeadlessPermissionProvider({
  stderr: (t) => process.stderr.write(t),
});

const generator = runAgentLoop({
  config,
  userPrompt: question,
  tools: builtinTools,
  signal: abortController.signal,
  llmLogSink: options.debug ? llmLogSink : undefined,
  // ask 默认 acceptEdits：FileWrite/FileEdit 直接放行（便于"生成代码"场景），
  // Bash 仍走规则判定 → ask → headless deny
  // --dangerously-skip-permissions → bypassPermissions
  permissionMode: options.dangerouslySkipPermissions === true ? "bypassPermissions" : "acceptEdits",
  permissionStore,
  permissionProvider,
  cwd: process.cwd(),
});
```

**ask 默认 `acceptEdits` 而 chat 默认 `default`**：headless 场景假设用户已经知道自己在让模型改文件，并预先准备好了项目规则；FileWrite/FileEdit 自动放行避免"模型生成代码后被 deny 浪费一次调用"的体验问题。Bash 仍受默认 ask 保护，配合 headless provider 的"统一 deny"，形成"shell 必须显式规则才放行、文件可自动改"的安全/便利平衡。

`permissionStore.load` 失败的处理在 `handleAskError`（§161-185），与 chat 一样映射到退出码 1。

## 7. `--dangerously-skip-permissions` 在两个命令的不同路径

| 维度 | chat | ask |
|---|---|---|
| flag 解析 | `parseChatFlags.ts` | `parseAskFlags.ts` |
| 不带 flag 时 mode | `default` | `acceptEdits` |
| 带 flag 时 mode | `bypassPermissions` | `bypassPermissions` |
| 影响 | 所有非 DENY_PATTERNS 工具自动放行 | 同左 |
| 不影响 | DENY_PATTERNS（rm -rf / sudo / mkfs ...） | 同左 |

**flag 名字带 "dangerously"**：参考 `npm install --force` / `git push --force` 的命名传统，让用户每次输入这个 flag 都意识到自己在做危险事。

**两条路径都通向同一 mode**：engine 只看 mode 不看入口，所以 chat 和 ask 在 bypass 模式下行为完全等价（除了 provider 永远不会被调用之外）。

## 8. renderAgentEvent —— stderr 渲染

[`renderAgentEvent.ts`](../../../src/commands/ChatCommand/renderAgentEvent.ts) §77-95：

```typescript
case "permission_request":
  if (state.inAssistantText) {
    io.stdout("\n");           // 把上一行 assistant 文字补一个换行，避免拥挤
    state.inAssistantText = false;
  }
  io.stderr(`[permission] asking: ${event.toolName} (${event.reason})\n`);
  break;

case "permission_decision":
  if (event.decision === "deny") {
    io.stderr(`[permission] denied: ${event.toolName} (${event.reason})\n`);
  } else if (event.persisted !== undefined) {
    io.stderr(`[permission] allowed & saved to ${event.persisted}: ${event.toolName}\n`);
  }
  // allow + 未升级（allow-once）：不打印，避免噪点
  break;
```

**三档输出策略**：
- **asking**：永远打印（这一刻 UI 阻塞了，用户需要知道"是被权限层拦了，不是模型在思考"）
- **denied**：永远打印（用户必须知道为什么 LLM 没执行某条工具）
- **allowed-once**：不打印（每次都打一行噪点太多）
- **allowed-and-persisted**：打印（让用户知道规则被加进哪一层，便于回头审计 / 编辑）

**前置补换行**：`if (state.inAssistantText) io.stdout("\n")` —— 防止 LLM 正在写一段文字时突然弹权限提示导致格式错乱。这种"状态机式渲染"是 M2 引入的 `RenderState` 思路（参考 [`docs/architecture/M2/repl-loop.md`](../M2/repl-loop.md) §渲染状态机）的延续。

ask 命令在 [`runAskWithLLM.ts`](../../../src/commands/AskCommand/runAskWithLLM.ts) §130-147 有等价的内联渲染（不复用 ChatCommand 的 renderAgentEvent，因为两者 stdout/stderr 切分语义略不同），但行为基本一致：asking / denied 各打一行。

## 9. 端到端时序：chat 用户手动升级一条 git 规则

```
User 输入: "看一下 git status"
    │
    ↓
ChatSession.sendTurn → runAgentLoop
    │
    ├─ LLM 第一轮：Bash { command: "git status -s" }
    │
    ├─ executeToolsAndYieldEvents
    │     ├─ yield tool_call (UI 打 "[tool] Bash ...")
    │     │
    │     ├─ Phase A: evaluatePermission
    │     │     mode=default + Bash + requiresApproval=true + 无规则
    │     │     → Step 6: decision=ask, reason="tool requires approval"
    │     │     → yield permission_request
    │     │       (UI 打 "[permission] asking: Bash (tool requires approval)")
    │     │
    │     ├─ provider.requestPermission(req)
    │     │     replPermissionProvider 显示 5 档菜单
    │     │     用户输入 "2"
    │     │     return "allow-always-session"
    │     │
    │     ├─ decisionFromUserChoice("allow-always-session")
    │     │     → { decision: "allow", persistTo: "session" }
    │     │
    │     ├─ buildPersistedRule("Bash", { command: "git status -s" })
    │     │     → { toolName: "Bash", ruleContent: "git:*", behavior: "allow" }
    │     │
    │     ├─ store.addRule("session", rule)   (内存追加)
    │     │
    │     ├─ yield permission_decision { decision:"allow", persisted:"session" }
    │     │     (UI 打 "[permission] allowed & saved to session: Bash")
    │     │
    │     └─ Phase B: BashTool.execute → "M  src/QueryEngine.ts ..."
    │         Phase C: yield tool_result (UI 打输出)
    │
    └─ LLM 第二轮：基于 git status 输出回答用户

  ─── 同 session 内用户接着说 "再 git diff 一下" ───
    │
    └─ Phase A: evaluatePermission
          mode=default + Bash + 1 条 session 规则 "git:*" allow
          → Step 4: 命中 session allow rule
          → decision=allow，**直接放行**，不再问

```

**这就是"chat 培训规则"的核心体验**：用户在第一次见到 `git` 命令时升级一次，整个 session 后续 git 命令都自动放行；如果选 project / global，下一次开 chat / ask 还能继续受益。

## 10. 测试与可观测性

### 10.1 测试覆盖

| 文件 | 范围 |
|---|---|
| [`slash/permissions.test.ts`](../../../src/commands/ChatCommand/slash/permissions.test.ts) | `/permissions list` / `mode [m]` / 未注入兜底 / 非法 mode |
| [`replPermissionProvider.test.ts`](../../../src/commands/ChatCommand/replPermissionProvider.test.ts) | 5 档解析 / 空行 / EOF / 无效循环 |
| `permissionEngine.test.ts` | 七步流水线（与集成无关） |
| `permissionStore.test.ts` | 三层规则 + IO（与集成无关） |
| QueryEngine 集成测试 | mock provider，验证 Phase A/B/C |

### 10.2 端到端验证

详见 [`docs/manual/M3-usage-guide.md`](../../manual/M3-usage-guide.md) §一致性验证三例：

1. chat 默认 mode + git status 升级到 session
2. ask + acceptEdits + FileWrite 自动放行
3. `--dangerously-skip-permissions` + 仍被 DENY_PATTERNS 拦的 `rm -rf /`

### 10.3 可观测性

权限决策的所有事件都流过 `debugSink`（chat-*.log）：

```jsonl
{"type":"permission_request","toolUseId":"tu_1","toolName":"Bash","input":{...},"reason":"tool requires approval"}
{"type":"permission_decision","toolUseId":"tu_1","toolName":"Bash","decision":"allow","reason":"user chose allow-always-session","persisted":"session"}
{"type":"tool_result","toolUseId":"tu_1","toolName":"Bash","content":"...","isError":false}
```

排查"为什么这次被 deny / 为什么这次没问"，按 toolUseId 在 chat-*.log 里 grep 即可拿到完整决策路径 + reason。

## 11. 与 claude-code 的差异速查

| 维度 | claude-code | nova-code M3 |
|---|---|---|
| flag 名 | `--dangerously-skip-permissions` | 同 |
| ask 默认 mode | acceptEdits / 类似 | acceptEdits |
| chat 默认 mode | default | default |
| `/permissions` 入口 | TUI 弹窗 + 列表 + add/remove | stderr list / mode 切换；不实现 add/remove |
| ModeRef 抽象 | 内部 useState | mutable closure（更直观） |
| Provider 来源 | bridge callbacks | 显式 PermissionProvider 接口 |

差异背后的设计动机：bridge / TUI 在 nova-code M3 不必移植，CLI 直接吃 stdin/stderr 已足够；保留 add/remove 给 M4+。

---

回到入口：[README.md](./README.md)
