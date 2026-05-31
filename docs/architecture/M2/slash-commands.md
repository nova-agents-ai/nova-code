# 斜杠命令体系

对应源目录：[src/commands/ChatCommand/slash/](../../../src/commands/ChatCommand/slash/)

斜杠命令是 chat REPL 的「带内控制平面」：在同一输入框里既能和模型对话，又能
通过 `/xxx` 触发本地动作（清空历史、保存、退出 等）。本文档解释 M2 如何组织
这套体系。

---

## 1. 为什么独立于顶层 CommandDefinition

顶层 `CommandDefinition`（见 [src/commands/types.ts](../../../src/commands/types.ts)）是
**子进程启动时跑一次**的命令（`nova-code ask ...`、`nova-code chat ...`）。
SlashCommand 在 **REPL 中每轮可能触发多次**、而且必须拿到 `ChatSession` 句柄。

两者的关键差异：

| 维度 | CommandDefinition | SlashCommand |
|------|-------------------|--------------|
| 触发时机 | 进程启动一次 | REPL 内任意一轮 |
| 上下文 | args: string[] | session + io + args + configSource |
| 执行完 | 进程 exit(n) | 返回 continue/exit，REPL 决定后续 |
| IO | 直接 console.* | 通过 SlashIO 抽象（便于测试） |

强行统一会让 CommandDefinition 胀成"万能入口"，破坏职责单一。
M2 选择复制而非抽象 —— 两套定义文件都 ≤ 60 行，成本可接受。

---

## 2. 四件套类型（types.ts）

### 2.1 SlashCommand

```ts
interface SlashCommand {
  readonly name: string;            // 不带前导 `/`
  readonly description: string;     // 一行简介，出现在 /help 列表
  readonly usage: string;           // 用法说明（可多行）
  run(ctx: SlashContext): Promise<SlashResult>;
}
```

约定 `run` **保证不抛**：用户可见的失败都走 `ctx.io.print(...)` + 返回
`{ action: "continue" }`。这样 dispatcher 不用包 try/catch，REPL 主循环也不会被命令异常冲掉。

### 2.2 SlashContext

```ts
interface SlashContext {
  readonly session: ChatSession;
  readonly io: SlashIO;
  readonly args: readonly string[];
  readonly configSource?: ConfigSource;
}
```

- **session**：命令对会话状态的直接句柄（clear / snapshot / restore）
- **io**：print/confirm 抽象（见下）
- **args**：dispatcher 切分过的位置参数，不含命令名本身
- **configSource**：仅供单测注入 `{ homeDir: tmpHome }`；生产不传

### 2.3 SlashIO

```ts
interface SlashIO {
  print(text: string): void;
  confirm(prompt: string): Promise<boolean>;
}
```

两个方法全都在 runChatRepl 里用 readline 实装：

```ts
const slashIO: SlashIO = {
  print: (text) => io.stderr(text),          // 斜杠命令输出走 stderr
  confirm: async (prompt) => {
    const line = await readLine(prompt);
    if (line === null) return false;
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  },
};
```

- `print` 走 **stderr** 而非 stdout：对话正文留 stdout 干净，命令回显不搅乱
- `confirm` 语义：yes/y（大小写不敏感）为真；取消 / Ctrl+D / 其他都为假

### 2.4 SlashResult

```ts
type SlashResult =
  | { readonly action: "continue" }
  | { readonly action: "exit"; readonly exitCode?: number };
```

M2 只有这两种。未来扩 `/resume`、`/model` 可能需要 `"reload"` action（触发
REPL 重建 session），但那是 M3+ 的事，当前两值足够。

---

## 3. dispatcher（dispatcher.ts）

职责：把"用户刚按完回车的那一整行"分类：

```
input = "hello"           → handled=false         （非斜杠，REPL 交给 sendTurn）
input = "/"               → print "空命令"+ continue
input = "/unknown foo"    → print "未知命令"+ continue
input = "/save main"      → command.run({ args: ["main"], ... })
```

### 3.1 解析规则

```ts
const tokens = input.slice(1).trim().split(/\s+/);
const name = tokens[0] ?? "";
const args = tokens.slice(1);
```

- `\s+` 匹配包含 Tab 的任意空白，符合 shell 直觉
- **不支持引号转义**：`/save "with spaces"` 会被切成 `["\"with"]` 和 `["spaces\""]`。
  M2 非目标；命令集合里也没有任何会接受空格 alias 的场景
- 空命令 `/` 被单独识别，打印友善提示而非报"未知命令"

### 3.2 DispatchResult 双层结构

```ts
type DispatchResult =
  | { handled: false }                                 // 非斜杠
  | { handled: true; result: SlashResult };            // 已消化
```

`handled` 让 REPL 主循环 if/else 清晰：

```ts
if (dispatch.handled) {
  if (dispatch.result.action === "exit") return dispatch.result.exitCode ?? 0;
  continue;
}
// 下面走 session.sendTurn
```

不把 "非斜杠" 写成 `result: { action: "passthrough" }`，是因为 passthrough
在语义上属于 dispatcher 的**外部**关注点（REPL 的分发逻辑），而非命令的返回值。

---

## 4. registry.ts：避循环引用的工厂注册

问题：`/help` 命令需要列出所有命令，但 registry 又必须在 help 存在后才能构建
完整列表 —— help.ts ↔ registry.ts 存在循环引用风险。

解法：**把 registry 当 getter 闭包注入给 help**。

```ts
// registry.ts
const nonHelpCommands: readonly SlashCommand[] = [
  clearCommand, exitCommand, saveCommand, loadCommand,
];
const helpCommand = makeHelpCommand(() => builtinSlashCommands);
export const builtinSlashCommands: readonly SlashCommand[] = [
  ...nonHelpCommands, helpCommand,
];
```

```ts
// help.ts
export function makeHelpCommand(allCommands: () => readonly SlashCommand[]): SlashCommand {
  return {
    name: "help",
    run: async (ctx) => {
      const commands = allCommands();   // 每次调用时再求值，拿到完整列表
      ...
    },
  };
}
```

关键点：
- `makeHelpCommand` 收的是 **getter 函数**而非数组 —— 在 registry.ts 的
  `export const builtinSlashCommands = [..., helpCommand]` 这行**之后**才会被
  调用，所以 help 看到的列表天然包含自己
- getter 闭包引用的是 const 绑定（not snapshot），后续若扩 plugin 再加命令也生效

### 4.1 展示顺序

```
clear → exit → save → load → help
```

设计取舍：
- 常用且无风险的 `clear`、`exit` 前置
- 持久化类 `save`/`load` 中段
- `help` 垫底（用户往往不翻找它，放最后符合扫读习惯）

### 4.2 findSlashCommand：线性扫

```ts
export function findSlashCommand(name: string): SlashCommand | undefined {
  for (const cmd of builtinSlashCommands) {
    if (cmd.name === name) return cmd;
  }
  return undefined;
}
```

命令不到 10 条，线性扫 O(n) ≈ O(1)；换成 Map 反倒要维护另一份索引，收益为负。

---

## 5. 内置命令逐个说明

### 5.1 `/clear`（[clear.ts](../../../src/commands/ChatCommand/slash/clear.ts)）

```ts
ctx.session.clear();
ctx.io.print("已清空当前会话历史。\n");
return { action: "continue" };
```

- **只清 messages，保留 meta**：sessionId / model / createdAt 不变
- 用户心智："重开一段对话但仍沿用这个会话文件"
- 之后 `/save` 仍写到同一个 sessionId.jsonl，旧内容被覆盖

### 5.2 `/exit`（[exit.ts](../../../src/commands/ChatCommand/slash/exit.ts)）

```ts
return { action: "exit", exitCode: 0 };
```

- 与 Ctrl+C 双按的区别：`/exit` 是**明确意图**，退出码 0（普通结束）；
  Ctrl+C 双按是中断，退出码 130（SIGINT 语义）
- 不做额外 cleanup —— debugSink/llmLogSink 的 close 由 ChatCommand 的 `finally` 兜底

### 5.3 `/save [alias]`（[save.ts](../../../src/commands/ChatCommand/slash/save.ts)）

```ts
const snapshot = { meta: session.meta, messages: session.snapshot() };
await saveSession(session.meta.sessionId, snapshot, configSource);
if (alias) await saveSession(alias, snapshot, configSource);
```

- **永远按 sessionId 写一份主记录**，即便用户传了 alias
- alias 是**额外**一份文件副本，方便人类用 `/load main-feature` 而非
  `/load 2026-05-04T14-23-07-9a8b4c2d`
- 错误全部在 command 内 catch → `io.print` → 返回 continue（符合"不抛"约定）

### 5.4 `/load <idOrAlias>`（[load.ts](../../../src/commands/ChatCommand/slash/load.ts)）

流程：

```
1. 参数校验：空则 print usage + continue
2. 若当前 session 非空 → io.confirm("当前会话将被替换，继续？(y/n) ")
   用户答 n / EOF / 超时 → print "已取消"+ continue
3. loadSession(target) → 得到 { meta, messages }
4. session.restore(meta, messages)   ← meta 整个被换掉
5. print "已加载 <sessionId>（N 条消息）"
```

- 二次确认只在"当前会话已有对话"时出现；刚开的空会话直接替换不打扰
- **restore 替换 meta**：sessionId 也跟着变（变成被加载的那个）。之后 /save
  就写到新 sessionId 的文件，避免把别人的会话 id 覆盖掉

### 5.5 `/help`（[help.ts](../../../src/commands/ChatCommand/slash/help.ts)）

```
可用斜杠命令：
  /clear  清空当前对话历史（sessionId 保留）
  /exit   退出 chat REPL
  /save   把当前会话保存到 ~/.nova-code/sessions/
  /load   从 ~/.nova-code/sessions/ 恢复一个会话
  /help   列出所有斜杠命令
```

用 description 而非 usage —— `/help` 要的是一览表，详细用法属于单个命令出错
时自己 print usage 的职责（目前 save/load 带参数校验时会这么做）。

---

## 6. 测试策略

### 6.1 dispatcher 单测（[dispatcher.test.ts](../../../src/commands/ChatCommand/slash/dispatcher.test.ts)）

覆盖用例：
- 非斜杠 → `handled: false`
- 只输 `/` → 友善提示 + continue
- 未知命令 → 特定提示 + continue
- 多空白切分：`/save   main-feature  extra` → args=["main-feature", "extra"]
- tab 分隔：`/save\tmain` → 同样切对
- exit 透传：`/exit` → `{ action: "exit", exitCode: 0 }`

### 6.2 单条命令单测

每个命令自测只用 mock `SlashIO`（两个同步方法）+ 真实 ChatSession（构造简单）
+ tmp home via ConfigSource —— 完全不依赖 readline/TTY。

---

## 7. 扩展指南（给 M3+）

若要新增一条斜杠命令：

1. 在 `slash/` 下新建文件（比如 `cost.ts`），导出 `export const costCommand: SlashCommand`
2. 在 [registry.ts](../../../src/commands/ChatCommand/slash/registry.ts) 的
   `nonHelpCommands` 数组里加一项；顺序决定 `/help` 输出次序
3. 写一份 `cost.test.ts` 做单测

如果要扩结果动作（比如 `/model gpt` 切换模型需要让 REPL 重建 session）：

1. 在 `SlashResult` 加 `{ action: "reload"; ... }` 第三种
2. 在 runChatRepl 主循环 `dispatch.handled` 分支加 `case "reload"` 处理
3. 保持既有命令不动（它们仍只返回 continue/exit）

---

## 8. 下一步

- 斜杠命令被谁调用：[repl-loop.md](./repl-loop.md)
- `/save` / `/load` 的 JSONL 细节：[session-store.md](./session-store.md)
- `ctx.session` 能用哪些 API：[chat-session.md](./chat-session.md)
