# 05 · QueryEngine 三阶段改造

> 本篇拆解 [`src/QueryEngine.ts`](../../../src/QueryEngine.ts) 在 M3 的改造：从 M2 的"并行 execute"变成 Phase A 串行权限判定 + Phase B 并行 execute + Phase C 按序组装。
>
> 这是 M3 影响范围最大的非新增代码改动，**但向后兼容**——4 个权限相关字段全部可选，不传时 QueryEngine 行为与 M1/M2 完全一致。

## 1. 接口增量

`AgentLoopParams` 新增 4 个 readonly 字段（[`QueryEngine.ts`](../../../src/QueryEngine.ts) §118-134）：

```typescript
export interface AgentLoopParams {
  // ── 已有字段（M1.5 / M2）
  config; userPrompt; initialMessages?; systemPrompt?; tools;
  signal?; client?; llmLogSink?;

  // ── M3 权限系统注入（4 个同进同出）
  readonly permissionMode?: PermissionMode;
  readonly permissionStore?: PermissionStore;
  readonly permissionProvider?: PermissionProvider;
  readonly cwd?: string;
}
```

**4 个字段的耦合关系**：
- `permissionMode` + `permissionStore` 必须同进同出（`undefined === undefined`）才启用权限系统
- `permissionProvider` 仅在决策为 ask 时被调用——不传 + 决策 ask = 安全从严降级 deny
- `cwd` 仅给 `evaluatePermission.cwd` 用；不传时 fallback 到 `process.cwd()`

```typescript
if (permissionMode === undefined || permissionStore === undefined) {
  decisions.push({ use, decision: "allow" });   // 退化为 M1/M2 全放行
  continue;
}
```

**为什么 4 个字段都可选而不是搞一个 `PermissionContext` 对象**：现有的 QueryEngine 测试与 M1/M2 调用方都传不到这些字段；可选字段 + 默认行为兼容已有代码，避免大规模改测试。代价是 4 个字段需要由调用方"凑齐"——`ChatCommand.ts` / `runAskWithLLM.ts` 都遵循"要么 4 个全传、要么全不传"的约定。

## 2. AgentEvent 新增 2 个

[`types/message.ts`](../../../src/types/message.ts) §111-131：

```typescript
type AgentEvent =
  | { type: "turn_start" | "text_delta" | "tool_call" | "tool_result"
        | "turn_end" | "done" | ... }
  // ── M3 新增 ──
  | { type: "permission_request";
      toolUseId: string; toolName: string;
      input: Readonly<Record<string, unknown>>;
      reason: string;                                        // engine 给的 ask 原因
    }
  | { type: "permission_decision";
      toolUseId: string; toolName: string;
      decision: PermissionDecision;
      reason: string;
      persisted?: PermissionRuleSource;                      // allow-always-* 时填
    };
```

**为什么是两个事件而不是一个**：
- `permission_request` 在 provider 被调用**之前**发出——UI 可以先打"正在询问"提示，再阻塞等用户输入
- `permission_decision` 在拿到结果**之后**发出——UI 可以打"已允许 / 已拒绝 / 已升级到 X 层"提示

中间夹着 `await provider.requestPermission(...)`，时间窗口可能很长（用户思考 5 秒）。两个事件让 UI / debug log 都能精确捕捉到"询问开始"和"决策落定"两个时刻。

## 3. `executeToolsAndYieldEvents` 三阶段

源码：[`QueryEngine.ts`](../../../src/QueryEngine.ts) §390-582。

### 3.1 入口签名

```typescript
async function* executeToolsAndYieldEvents(params: ExecuteToolsParams):
  AsyncGenerator<AgentEvent, ToolResultBlock[], void>

interface ExecuteToolsParams {
  readonly toolUses: readonly ToolUseBlock[];
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  // 4 字段同 AgentLoopParams
  readonly permissionMode?: PermissionMode;
  readonly permissionStore?: PermissionStore;
  readonly permissionProvider?: PermissionProvider;
  readonly cwd?: string;
}
```

### 3.2 流程总览

```
入口
  └─ 先按声明顺序 yield tool_call × N      ── UI 立刻看到本轮所有工具
  ↓
Phase A：串行权限判定              （for 循环，await）
  for use of toolUses:
    if 未注入权限 → decision="allow" 直接入列
    else:
      result = evaluatePermission(...)
      switch result.decision:
        "allow"  → decisions.push({ use, "allow" })
        "deny"   → yield permission_decision; decisions.push({use,"deny",reason})
        "ask"    → if no provider → 同上 deny + 兜底 reason
                   else:
                     yield permission_request
                     choice = await provider.requestPermission(...)
                     outcome = decisionFromUserChoice(choice)
                     if outcome.persistTo: rule = buildPersistedRule(...)
                                           await store.addRule(persistTo, rule)
                     yield permission_decision { decision, reason, persisted? }
                     decisions.push({...})
  ↓
Phase B：并行 execute             （Promise.allSettled）
  allowedIndexes = decisions 中 decision==="allow" 的下标
  settled = await Promise.allSettled(allowedIndexes.map(i =>
     executeOneTool(decisions[i].use, tools, signal)))
  ↓
Phase C：按原始顺序组装             （同步）
  for i in 0..decisions.length:
    if decisions[i].decision === "deny":
       block = { tool_result, content: `Permission denied: <reason>`, is_error: true }
       results.push(block); yield tool_result(...)
    else (allow):
       outcome = settled[settledCursor++]
       if fulfilled: 正常 block
       if rejected: error block (describeToolError)
       results.push; yield tool_result
  return results   ── 用作"下一轮 user 消息"的 content
```

**关键性质**：
1. **Phase A 是串行的**——避免多个 ask 弹窗同时占用 stderr 互相覆盖
2. **Phase B 是并行的**——和 M2 的并行 execute 完全等价，性能不退化
3. **Phase C 按声明顺序产出**——保证 LLM 拿到的 `tool_result` 顺序与请求顺序一致（claude-code 已证明这是 SDK 兼容性的硬要求）

## 4. Phase A 详解：决策记录 `ToolDecision`

```typescript
interface ToolDecision {
  readonly use: ToolUseBlock;
  readonly decision: "allow" | "deny";
  readonly denyReason?: string;
}
```

**注意 decision 只有两档**——"ask" 在 Phase A 内部就被消化掉了（要么变 allow 要么变 deny）。Phase B/C 看不到 ask。

**为什么记 `denyReason` 而不是直接拼 `Permission denied: ...` 入列**：保留原始 reason 便于 Phase C 区分以下三种 deny：
- engine deny（DENY_PATTERNS / 规则 deny）→ reason: `blocked by ...`
- provider 不存在 → reason: `... (no permission provider configured, denying by default)`
- 用户 deny → reason: `user denied (deny)`

UI / debug log 拿到不同 reason 能给出针对性的"为什么这次被拒"解释。

## 5. Phase A 详解：调用 provider 后的"持久化分支"

```typescript
const outcome = decisionFromUserChoice(choice);

let persisted: PermissionRuleSource | undefined;
if (outcome.decision === "allow" && outcome.persistTo !== undefined) {
  const rule = buildPersistedRule(use.name, use.input);
  if (rule !== undefined) {
    await permissionStore.addRule(outcome.persistTo, rule);
    persisted = outcome.persistTo;
  }
}

yield {
  type: "permission_decision",
  decision: outcome.decision,
  reason: `user chose ${choice}`,
  ...(persisted !== undefined ? { persisted } : {}),
};
```

**两个细节**：
- `buildPersistedRule` 可能返回 `undefined`（输入不合法、提取不到 command/path）—— 这种情况下 `persisted` 留空，但本次仍按 allow 执行。"放行了但没存"是合法状态。
- `addRule` 是 `await`——session 写入即时返回，project/global 会触发 fs.writeFile，**这段时间整个 Phase A 是阻塞的**。这也是为什么 Phase A 必须串行。

## 6. `buildPersistedRule` —— 升级时构造规则

[`QueryEngine.ts`](../../../src/QueryEngine.ts) §584-608：

```typescript
function buildPersistedRule(toolName: string, input: unknown): PermissionRule | undefined {
  if (toolName === BASH_TOOL_NAME) {
    const command = extractBashCommand(input);          // input.command
    if (command === undefined) return undefined;
    const first = command.trim().split(/\s+/)[0];       // 首 token
    if (first === undefined || first === "") return undefined;
    return { toolName, ruleContent: `${first}:*`, behavior: "allow" };
  }
  if (isFileWriteToolName(toolName)) {                  // FileWrite | FileEdit
    const filePath = extractFilePath(input);            // input.path
    if (filePath === undefined) return undefined;
    return { toolName, ruleContent: filePath, behavior: "allow" };
  }
  return { toolName, behavior: "allow" };               // 其它工具：整工具放行
}
```

**升级语义**：

| 工具 | 入参 | 升级后的 rule.ruleContent |
|---|---|---|
| Bash `git status -s` | `command: "git status -s"` | `git:*`（命令名 + `:*`） |
| Bash `git push origin main` | `command: "git push ..."` | `git:*`（注意：升级到命令名层级，覆盖整个 git 子命令） |
| FileWrite `/tmp/a.txt` | `path: "/tmp/a.txt"` | `/tmp/a.txt`（原始 path） |
| FileEdit `src/main.ts` | `path: "src/main.ts"` | `src/main.ts` |
| GlobTool（整工具） | （任意） | （ruleContent 缺省） |

**Bash 升级到命令名层级**——而不是 `git status:*` 或 `git status -s`——是 M3 当前版本的"直观放宽"策略。设计稿 §九已记下未来增强：

> 当前 buildPersistedRule 把 git 命令统一升级到 `git:*`。未来 Task 7+ 可能让 UI 询问用户"要升级成什么形式的规则"（更窄 / 更宽），M3 当前版本采用"命令名 + :*"这种直观的放宽策略。

## 7. Phase B 详解：`Promise.allSettled`

```typescript
const allowedIndexes: number[] = decisions.flatMap((d, i) =>
  d.decision === "allow" ? [i] : []
);
const settled = await Promise.allSettled(
  allowedIndexes.map((i) => executeOneTool(decisions[i].use, tools, signal))
);
```

**为什么 `allSettled` 而不是 `all`**：
- 一个 tool 抛异常不应中断其它工具
- 异常会在 Phase C 被映射成 `tool_result { is_error: true }`，让 LLM 拿到错误描述继续推理
- 与 M2 的并行 execute 行为完全对齐

**`signal` 的传递**：每个 `executeOneTool` 都拿同一个 `signal`，用户 Ctrl+C 时能整批中止。AbortError 也走 fulfilled/rejected 通道，被 Phase C 处理为 error tool_result。

## 8. Phase C 详解：按原始顺序组装 + 双 cursor

```typescript
const results: ToolResultBlock[] = [];
let settledCursor = 0;
for (let i = 0; i < decisions.length; i += 1) {
  const d = decisions[i];
  if (d.decision === "deny") {
    // 用 denyReason 拼 tool_result
    results.push({ type: "tool_result", tool_use_id: d.use.id,
                   content: `Permission denied: ${d.denyReason}`, is_error: true });
    yield { type: "tool_result", ..., isError: true };
    continue;
  }
  // allow：取 settled 队列下一项
  const outcome = settled[settledCursor++];
  if (outcome.status === "fulfilled") { /* 正常 */ }
  else                                 { /* error */ }
}
return results;
```

**双 cursor 的妙用**：`settled` 数组只对应 allow 的工具（短），而 `decisions` 包含所有 deny（长）。`settledCursor` 让 Phase C 在按 `decisions` 顺序遍历的同时，对 allow 项依次"消费" settled 结果。

**deny 也产出 tool_result**——LLM 必须拿到所有 tool_use_id 对应的 tool_result，少一条 SDK 就会 reject 下一轮请求。`Permission denied: <reason>` 让 LLM 看见原因，可以解释给用户或选择不同的工具。

## 9. 兼容性矩阵

```
permissionMode  permissionStore  permissionProvider     行为
─────────────────────────────────────────────────────────────────────────
undefined        undefined        undefined             M1/M2 行为：全放行
defined          defined          undefined             ask → deny；allow/deny → 正常
defined          defined          defined               完整 M3：5 档 + 升级
undefined        defined          ?                     退化全放行（mode 缺）
defined          undefined        ?                     退化全放行（store 缺）
```

测试可以通过传不同组合验证退化路径。源码 §411-415 的"两个 undefined 任一就 fallback 全放行"是这套兼容性矩阵的实现位置。

## 10. 与 M1/M2 行为差异速查

| 维度 | M1/M2 | M3 |
|---|---|---|
| 工具决策 | 立即 execute | Phase A 决策 → Phase B execute |
| 并行度 | 全并行 | Phase A 串行 + Phase B 并行 |
| AgentEvent | tool_call / tool_result | + permission_request / permission_decision |
| 失败兜底 | 异常映射 tool_result | 同上 + deny 也映射 tool_result |
| 入参字段 | `params: AgentLoopParams` | + 4 个权限可选字段 |
| 不传权限字段时 | — | 与 M1/M2 完全一致（向后兼容） |

## 11. 测试影响

[`QueryEngine.test.ts`](../../../src/QueryEngine.test.ts) 的 M2 用例**不需要改一行**——它们都没传 4 个权限字段，走 fallback 全放行。新增的 M3 用例独立组：

- 注入 store + mode，无 provider → ask 工具自动 deny
- 注入 store + mode + provider mock(`() => "allow-once"`) → ask 工具放行，无规则升级
- 注入完整 → mock provider 返回 "allow-always-session" → 验证 store.addRule 被调用 + permission_decision 带 persisted

QueryEngine 的测试矩阵随 M3 的扩张主要在"权限状态空间"，不在"loop 控制流"——后者已被 M2 充分覆盖。

---

下一篇：[06 · chat-ask-integration.md](./chat-ask-integration.md)
