# 04 · Permission Provider —— 询问用户的两种实现

> 本篇拆解 [`PermissionProvider.ts`](../../../src/services/permissions/PermissionProvider.ts) 接口与两个具体实现：
>
> - REPL 5 档菜单 [`replPermissionProvider.ts`](../../../src/commands/ChatCommand/replPermissionProvider.ts)
> - Headless auto-deny [`headlessPermissionProvider.ts`](../../../src/commands/AskCommand/headlessPermissionProvider.ts)
>
> 还会顺带讲清 `decisionFromUserChoice` 怎么把 5 档 UserChoice 映射回 `(decision, persistTo?)`。

## 1. 接口形状

```typescript
export interface PermissionRequest {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;   // engine 给的"为什么要询问"
}

export interface PermissionProvider {
  requestPermission(request: PermissionRequest): Promise<UserChoice>;
}
```

故意只暴露这一个方法。理由：
- **`Promise` 返回**：实现可以阻塞任意长时间等待用户输入（REPL 模式）或立刻 resolve（headless 模式）。
- **不让 provider 决定 `decision`**：返回 `UserChoice` 而不是 `PermissionDecision`，是因为"放行 + 持久化到哪一层"这一步的语义是 engine/QueryEngine 关心的；provider 只负责"用户选了什么"。
- **不接 store / mode**：provider 不需要 store，因为持久化由 QueryEngine 在拿到 choice 后再做。这让 provider 可以轻松 mock。

## 2. UserChoice → 决策映射

```typescript
export interface UserChoiceOutcome {
  readonly decision: PermissionDecision;             // 只会是 allow 或 deny
  readonly persistTo?: PermissionRuleSource;         // 是否升级 + 升级到哪层
}

export function decisionFromUserChoice(choice: UserChoice): UserChoiceOutcome {
  switch (choice) {
    case "allow-once":               return { decision: "allow" };
    case "allow-always-session":     return { decision: "allow", persistTo: "session" };
    case "allow-always-project":     return { decision: "allow", persistTo: "project" };
    case "allow-always-global":      return { decision: "allow", persistTo: "global" };
    case "deny":                     return { decision: "deny" };
  }
}
```

**5 档为什么没有 `deny-always`**？设计稿 §六明示："否定规则不走用户交互升级，应显式书面声明（`/permissions add ... deny`，未来版本提供）。"理由是手滑选了 deny-always 之后，找不回来——而 deny 规则恰好是安全敏感的，应该让用户走"打开文件、编辑 JSON"这种重操作路径，给一次冷静思考的机会。

**对应 engine 的整体闭环**：

```
engine.evaluate → "ask"
      ↓ provider.requestPermission(req)
      ← UserChoice
            ↓ decisionFromUserChoice(choice)
            ← { decision, persistTo? }

QueryEngine：
   if persistTo:
      buildPersistedRule(toolName, input)   ── 见 query-engine-phases.md §6
      await store.addRule(persistTo, rule)
   yield permission_decision { decision, reason: `user chose ${choice}`, persisted? }
```

## 3. REPL 实现 —— `replPermissionProvider`

代码 94 行，单一职责。

### 3.1 构造与依赖

```typescript
export interface ReplPermissionProviderDeps {
  readonly io: ReplIO;                                  // { stdout, stderr }
  readonly readLine: (prompt: string) => Promise<string | null>;   // EOF/close 返回 null
}

export function createReplPermissionProvider(deps): PermissionProvider
```

只依赖 `io` 和 `readLine`，**不绑死 readline 模块也不依赖 process.stdin**。这让单测能传入纯 mock 的 `readLine: async () => "2"`。

### 3.2 渲染与询问

```
[permission] Bash `git status -s` — tool requires approval
  1) allow once
  2) allow always (session)
  3) allow always (project)
  4) allow always (global)
  5) deny
  选择 1-5（回车=5 deny）:
```

格式约定：
- **header 一行**：`[permission] {tool}{ summary } — {reason}`
  - Bash → 摘要为 `` `command` ``（带反引号）
  - FileWrite/FileEdit → 摘要为 `file_path`
  - 其它工具 → JSON.stringify 截断到 80 字符
- **菜单 5 行**：固定文案，不本地化
- **prompt 一行**：写在 stderr，不污染 stdout 流式正文

回车（空输入）= 选 5 = deny。**这是"安全从严"原则的最后一道**：用户犹豫 / 误按回车 / EOF，都不会意外放行。

### 3.3 输入解析

```typescript
function parseChoice(input: string): UserChoice | undefined {
  if (input === "" || input === "5") return "deny";
  if (input === "1") return "allow-once";
  if (input === "2") return "allow-always-session";
  if (input === "3") return "allow-always-project";
  if (input === "4") return "allow-always-global";
  return undefined;   // 让循环再问一次
}
```

不认识的输入：stderr 打 `无效输入，请输入 1-5。` + 重新 prompt。**直到拿到合法选项才 return**——这个循环没有上限，依赖 readLine 的 EOF 信号兜底（EOF → null → 当作 deny return）。

### 3.4 与 SlashIO.confirm 不复用

ChatCommand 已有一个 `SlashIO.confirm` 用于 yes/no 提问（`/load` 弹确认）。replPermissionProvider 不复用它，理由：
- confirm 只支持 yes/no 两档，不够 5 档
- 复用等于在 confirm 上面再包一层；直接吃 `readLine + io` 更直观，源码更短

不强求"所有交互通过同一抽象"——简单胜过统一。

## 4. Headless 实现 —— `headlessPermissionProvider`

代码 52 行，更简单。

### 4.1 构造与行为

```typescript
export interface HeadlessPermissionProviderDeps {
  readonly stderr: (text: string) => void;
}

export function createHeadlessPermissionProvider(deps): PermissionProvider {
  return {
    requestPermission: async (req): Promise<UserChoice> => {
      deps.stderr(
        `[permission] headless mode auto-deny: ${req.toolName} (${req.reason})\n`
      );
      return "deny";
    },
  };
}
```

**永远返回 `"deny"`**：不读 stdin、不抛错、不延迟。理由：
- ask 是 non-interactive 场景，没有 TTY 可弹菜单
- 任何阻塞读 stdin 的操作都会让 ask 进程卡住

### 4.2 为什么"显式 auto-deny"而不是"don't even ask"

QueryEngine 在 `permissionProvider === undefined` 的情况下也会 deny（见 [`query-engine-phases.md`](./query-engine-phases.md) §3）。那为什么 ask 还要传一个"啥也不做只 deny"的 provider？

**两个目的**：

1. **stderr 审计** —— `[permission] headless mode auto-deny: ...` 让用户知道"为什么 LLM 说它没执行某个命令"。否则只看到 `[permission] denied: Bash ...` 容易误以为是用户配错了规则。
2. **保留升级路径** —— 未来 ask 可能加 `--auto-allow-known` 之类的选项让 headless provider 按规则自动决策。先把接口接好。

### 4.3 用户怎么让 ask 放行某条工具

设计稿 §六的"headless 默认 deny"对用户有暗示：要让 ask 模式跑某条 Bash 命令，必须**预先**写规则。两条路径：

1. 在 `~/.nova-code/permissions.json` 或 `<repo>/.nova-code/permissions.json` 手动加一条 `behavior: "allow"` 规则
2. 用 `chat` 进入 REPL → 手动跑一次同样命令 → 选 `allow-always-project/global` → 规则写盘 → 之后 ask 模式同样命令自动放行

**这种"chat 培训规则、ask 消费规则"的模式**是 M3 设计稿明确鼓励的工作流。

## 5. 两种 Provider 的对照

| 维度 | REPL Provider | Headless Provider |
|---|---|---|
| 出处 | `ChatCommand/replPermissionProvider.ts` | `AskCommand/headlessPermissionProvider.ts` |
| 触发 | engine 决策为 ask | 同左 |
| 交互 | 5 档 stderr 菜单 + readLine | 一行 stderr 提示，立即 return |
| 阻塞 | 等用户输入（任意时长） | 不阻塞 |
| 升级规则 | 可（allow-always-*） | 不可（始终 deny） |
| 测试 | mock readLine | mock stderr |

两者实现的是同一个 `PermissionProvider` 接口，对 QueryEngine 完全透明——QueryEngine 不知道也不关心是哪一种。

## 6. 当 Provider 不存在时

QueryEngine 的 Phase A 会检查 `permissionProvider === undefined`：

```typescript
if (permissionProvider === undefined) {
  const reason = `${evalResult.reason} (no permission provider configured, denying by default)`;
  yield { type: "permission_decision", decision: "deny", reason, ... };
  decisions.push({ use, decision: "deny", denyReason: reason });
  continue;
}
```

**安全从严降级**：决策为 ask 但没有 provider → 不放行、不抛错，转 deny。这层兜底使得：
- 测试里只传 store 不传 provider 是合法的（所有 ask 工具会 deny，可断言）
- 生产里如果 chat 启动时漏注入 provider，也只会全 deny 而不是宕机

## 7. 单测覆盖矩阵

[`replPermissionProvider.test.ts`](../../../src/commands/ChatCommand/replPermissionProvider.test.ts)：

- 5 档输入对照表（"1"→"allow-once" / "2"→"allow-always-session" / ...）
- 空行 → "deny"
- EOF（readLine 返回 null）→ "deny"
- 无效输入 → 再次 prompt 直到合法
- header 渲染：Bash 带反引号摘要 / FileWrite 带 path / 其它走 JSON

headless 实现简单到不需要单独单测：行为已在 ask e2e 里覆盖。

## 8. 与 claude-code 的差异

| 维度 | claude-code | nova-code M3 |
|---|---|---|
| Provider 抽象 | bridgePermissionCallbacks（绑定 bridge 子系统） | PermissionProvider（独立接口，`Promise<UserChoice>`） |
| REPL 菜单 | TUI 上下键选择 | stderr 写菜单 + 数字 readLine |
| Headless | 无独立实现（permission 主要走 GUI bridge） | 显式 headless provider，stderr 审计 |
| 升级档数 | 4-5 档（含 dontAsk） | 5 档（无 dontAsk，无 deny-always） |

差异背后的设计动机：bridge 子系统在 nova-code 不必移植；而 ask CLI 又需要明确的 headless 行为，所以独立抽出 provider 接口让两个命令各自实现。

---

下一篇：[05 · query-engine-phases.md](./query-engine-phases.md)
