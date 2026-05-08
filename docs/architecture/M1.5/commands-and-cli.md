# 02 · Commands & CLI —— 命令层与入口

> 对应文件：[bin/nova-code.ts](../../bin/nova-code.ts) / [src/cli.ts](../../src/cli.ts) / [src/commands.ts](../../src/commands.ts) / [src/commands/](../../src/commands)

---

## 1. 两级入口

```
bin/nova-code.ts          22 行   OS 可执行入口（仅在真实运行时用）
  ↓ runCli(meta)
src/cli.ts                116 行  纯函数分发（可被测试 / 库用户直接调用）
  ↓ command.run(rest)
src/commands/<X>Command/  具体命令实现
```

**为什么拆两层**：

- `bin/nova-code.ts` 负责"只有 OS 启动时才该做的事"：读 `package.json`、把退出码喂给 `process.exit`。
- `src/cli.ts` 纯分发，不做 IO。测试可以直接 `await runCli({argv: ["hello"]})` 拿到退出码，不必启子进程。

---

## 2. `bin/nova-code.ts`

```ts
#!/usr/bin/env bun
import packageJson from "../package.json" with { type: "json" };
import { runCli } from "../src/cli.ts";

const exitCode = await runCli({
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
});
process.exit(exitCode);
```

三件事：

1. 读 `package.json` 拿真实的 `name/version/description`（编译后的 dist 若丢失 package.json 相对路径，依然能注入）。
2. 调 `runCli` 拿到退出码。
3. `process.exit(exitCode)` 反馈 OS。

---

## 3. `src/cli.ts :: runCli`

框架式设计：所有"可变"都通过 `RunCliOptions` 注入，缺省落到内置默认。

```ts
interface RunCliOptions {
  readonly argv?: readonly string[];                     // 默认 process.argv.slice(2)
  readonly commands?: readonly CommandDefinition[];      // 默认 builtinCommands
  readonly name?: string;                                // "nova-code"
  readonly version?: string;                             // "1.0.0"
  readonly description?: string;                         // 内置文案
}
function runCli(options?: RunCliOptions): Promise<number>;
```

### 3.1 分发流程

```
argv[0] 为空                        → printHelp → return 0
argv[0] ∈ {-h, --help}              → printHelp → return 0
argv[0] ∈ {-v, --version}           → log "name vX" → return 0
findCommand(argv[0])                ─┬─ 未找到  → stderr "未知命令" → return 1
                                     └─ 找到    → await command.run(argv.slice(1))
  ├─ 正常返回退出码                            → return exitCode
  └─ 抛异常                                    → stderr "命令 X 执行失败: msg" → return 1
```

### 3.2 几个容易踩的约定

- `commands` 传入时**完全替换**内置（不是 merge）。需要"内置 + 额外命令"时，调用方手动 `[...builtinCommands, myCommand]`。
- 未知命令退出码 `1`，与命令自身执行失败（抛错）的退出码一致——两者都归类为"CLI 层面错误"。命令业务错误（如 `ask` 的 LLM 失败）由命令自己返回 `2`。
- `printHelp` 会按 `commands` 数组顺序展示，命令自己决定顺序（注册在 `builtinCommands` 里的就是 hello → echo → ask）。

---

## 4. 命令系统

### 4.1 `CommandDefinition` 契约

```ts
// src/commands/types.ts
type CommandHandler = (args: readonly string[]) => Promise<number> | number;

interface CommandDefinition {
  readonly name: string;           // 子命令名（如 "ask"）
  readonly description: string;    // --help 展示
  readonly usage: string;          // 示例段（--help 末尾）
  readonly run: CommandHandler;    // 业务入口
}
```

**`run` 的职责**：解析子命令 flag、执行业务、返回退出码。**不要**`process.exit`——让 `cli.ts` 收敛退出码传递。

### 4.2 聚合与查找（`src/commands.ts`）

```ts
export const builtinCommands: readonly CommandDefinition[] = [
  helloCommand,
  echoCommand,
  askCommand,
];

export function findCommand(
  name: string,
  commands: readonly CommandDefinition[] = builtinCommands,
): CommandDefinition | undefined {
  return commands.find((command) => command.name === name);
}
```

此外还兼容 re-export 了 `parseAskFlags` / `formatDebugPayload` / `buildDebugLogFileName`，避免历史测试改大范围 import。

---

## 5. 内置命令

### 5.1 `hello` —— CLI 骨架烟雾测试

- **文件**：[src/commands/HelloCommand/HelloCommand.ts](../../src/commands/HelloCommand/HelloCommand.ts)（17 行）
- **行为**：`nova-code hello [name]` → `Hello, <name|world>!`
- **作用**：CI/启动速检，无网络、无 LLM。

### 5.2 `echo` —— 参数回显

- **文件**：[src/commands/EchoCommand/EchoCommand.ts](../../src/commands/EchoCommand/EchoCommand.ts)
- **行为**：`nova-code echo a b c` → `a b c`
- **作用**：同上，演示"多参数拼接"形态。

### 5.3 `ask` —— 核心命令

- **目录**：[src/commands/AskCommand/](../../src/commands/AskCommand)（4 个文件）
- **职责切分**：

```
AskCommand.ts      命令注册 + I/O 胶水（命令行参数 / stdin 管道）
parseAskFlags.ts   flag 解析（--debug / --debug-pretty）
debugSink.ts       可选的文件 debug 汇
runAskWithLLM.ts   实际调 agent loop + 事件消费 + 错误映射
```

#### 5.3.1 `AskCommand.ts` — 只做胶水

```ts
run: async (args) => {
  const { debug, pretty, rest } = parseAskFlags(args);

  let question: string;
  const inline = rest.join(" ").trim();
  if (inline !== "") {
    question = inline;
  } else {
    // 从 stdin 读一行。交互终端额外显示 "Your question: " 提示
    const fromStdin = await readLineFromStdin();
    if (!fromStdin || fromStdin.trim() === "") {
      console.error("ask: 未提供问题。用法见 `nova-code --help`。");
      return 1;
    }
    question = fromStdin.trim();
  }
  return await runAskWithLLM(question, { debug, pretty });
}
```

几个设计选择：

- **命令行参数优先**：`nova-code ask "你好"` 与 `echo "你好" | nova-code ask` 都支持；前者更常用，放在前面。
- **stdin 读取手工实现**：Bun 当前版本的 `Bun.stdin.stream()` 类型未声明 `[Symbol.asyncIterator]`，手动 reader 既类型安全又行为明确。
- **交互 TTY 显示提示**："Your question: " 仅在 `process.stdin.isTTY === true` 时打印。管道输入场景不打印，保持输出干净。

#### 5.3.2 `parseAskFlags.ts` — 极简手工解析

```ts
interface AskFlags { debug; pretty; rest }
```

| flag | 效果 |
|---|---|
| `--debug` | 打开 debug sink，把完整 AgentEvent 流写文件 |
| `--debug-pretty` | **隐含开启 `--debug`**，改为多行缩进 + `\n` 渲染为真换行 |

不引入 `parseArgs` / `commander` 的原因：flag 极少，手工解析可读性更好，零额外依赖。未来 flag 增多时可整体替换。

#### 5.3.3 `runAskWithLLM.ts` — 事件消费

```ts
async function runAskWithLLM(question, { debug, pretty }): Promise<number>
```

流程：

1. 创建 `AbortController`，把 `SIGINT` 转为 `abortController.abort()`。
2. 根据 `debug` 决定走 `createFileDebugSink` 还是 `NULL_DEBUG_SINK`。
3. `loadConfig()` 拿 `ResolvedConfig`（env > 文件 > 默认）。
4. debug 模式下先写一条 `config_loaded` 脱敏日志（只留 apiKey 后 4 位）。
5. `runAgentLoop({config, userPrompt, tools: builtinTools, signal})` 拿 generator。
6. `for await (const event of generator)`：
   - **每条事件都喂给 debugSink**（全量落文件）
   - 按 type 做 stdout/stderr 输出：

| event.type | stdout | stderr |
|---|---|---|
| `turn_start` | — | `\n`（仅 turn > 1） |
| `text_delta` | `event.delta` | — |
| `tool_call` | `\n`（若刚在打印答案） | `\n[tool] <name> <JSON.stringify(input)>\n` |
| `tool_result` | — | `[tool] <name> failed: <content>`（仅 isError） |
| `done` | `\n`（末尾换行） | — |
| `turn_end` | — | — |

- **stdout = 模型答案**
- **stderr = 工具进度 / 错误 / debug 提示**

两条流分离后，`nova-code ask ... > answer.txt` 能拿到纯答案。

7. `catch` 走 `handleAskError` 映射退出码（见 §5.3.5）。
8. `finally` 关 debug sink + `removeListener("SIGINT", ...)`。

#### 5.3.4 `debugSink.ts` — 文件汇

```ts
interface DebugSink {
  write(payload: unknown): void;
  close(): void;
  logFilePath: string | null;
}
```

两个实现：

- `NULL_DEBUG_SINK`：`{ write: () => {}, close: () => {}, logFilePath: null }`。debug 关闭时用。
- `createFileDebugSink({pretty, sessionId?})`：

  | 选择 | 原因 |
  |---|---|
  | **同步 IO**（`openSync/writeSync`） | debug 量小，保证事件顺序严格 = 时序顺序 |
  | **`'a'` 追加模式** | 重名也不丢之前内容 |
  | **文件名**：`ask-YYYY-MM-DDTHH-mm-ss-<pid\|sessionId>.log` | 字典序 = 时序；M2 chat REPL 起用 sessionId 替代 pid |
  | **创建失败降级** | 打印警告、返回 `NULL_DEBUG_SINK`，不阻断主流程 |

- **pretty 模式**：

  紧凑 `pretty=false`：`[debug] {json}\n` 单行，便于 `grep` / `jq`。

  美化 `pretty=true`：
  ```
  --- <event.type> ---
  {
    "type": "...",
    "content": "第一行
  第二行"     ← 字符串中 \n 被渲染为真换行
  }
  ```

  实现用 sentinel 替换：先把真换行替换为 `\uE000NL\uE000`（Unicode 私有使用区，正常文本不会有），`JSON.stringify` 后再还原。注意 sentinel **不能用 C0 控制字符**（U+0000–U+001F）——JSON.stringify 会将其强制转义为 `\uXXXX` 字面量，导致 stringify 之后用原始字节匹配不到，还原彻底失效（M1.5 早期版本曾踩过这个坑）。

#### 5.3.5 错误 → 退出码映射

```ts
function handleAskError(error): number {
  if (ConfigError)          { stderr(msg); return 1;   }
  if (AbortError)           { stderr("已中断。"); return 130; }
  if (MaxTurnsExceededError){ stderr(msg); return 2;   }
  if (LLMApiError)          { stderr("LLM 请求失败 (HTTP xxx): msg"); return 2; }
  if (Error)                { stderr(msg); return 2;   }
  /* unknown */             { stderr(String(err));    return 2; }
}
```

| 退出码 | 语义 |
|---|---|
| `0` | 正常结束 |
| `1` | 配置错误（缺 API key、文件坏掉等）——可通过修改配置解决 |
| `2` | 运行时错误（LLM 网络、超限、工具、未知）——需要重试或查日志 |
| `130` | 用户中断（Ctrl+C） |

`1` 与 `2` 的区分：`1` 是"再跑一次也没用"；`2` 是"环境/网络修好就能跑通"。shell 脚本可以据此做差异化处理。

---

## 6. 端到端调用栈（重申）

```
shell
 └─ bin/nova-code.ts
     └─ runCli({name,version,description})       // src/cli.ts
         └─ findCommand("ask")                   // src/commands.ts
             └─ askCommand.run(["你好"])         // commands/AskCommand/AskCommand.ts
                 ├─ parseAskFlags                // commands/AskCommand/parseAskFlags.ts
                 ├─ readLineFromStdin（若需要）
                 └─ runAskWithLLM                // commands/AskCommand/runAskWithLLM.ts
                     ├─ createFileDebugSink      // commands/AskCommand/debugSink.ts
                     ├─ loadConfig               // config/config.ts
                     ├─ runAgentLoop             // QueryEngine.ts (见 agent-loop.md)
                     └─ handleAskError
```

---

## 7. 新增一个命令

1. `mkdir src/commands/FooCommand`
2. `src/commands/FooCommand/FooCommand.ts`:
   ```ts
   import type { CommandDefinition } from "../types.ts";
   export const fooCommand: CommandDefinition = {
     name: "foo",
     description: "...",
     usage: "nova-code foo [args...]",
     run: async (args) => { /* ... */ return 0; },
   };
   ```
3. `src/commands.ts`:
   ```ts
   import { fooCommand } from "./commands/FooCommand/FooCommand.ts";
   export const builtinCommands = [helloCommand, echoCommand, askCommand, fooCommand];
   ```
4. 测试：`src/commands.test.ts`（聚合）或 `src/commands/FooCommand/FooCommand.test.ts`（单命令）。

需要 flag 时，在子目录里再建 `parseFooFlags.ts`（仿 `parseAskFlags.ts` 的手工解析模式）。

---

## 8. CLI / 命令层的边界

**cli.ts 负责**：argv 分发、顶层 flag、未知命令提示、命令抛错的兜底捕获。

**cli.ts 不负责**：flag 解析、业务错误退出码、stdin 处理、debug 日志——都推给命令自己。

**命令负责**：flag 解析、IO（stdin/stdout/stderr）、配置加载、退出码。

**命令不负责**：argv 分发、顶层 --help/--version。

这条线保证了 `src/cli.ts` 永远是 116 行的纯分发，不会随着命令增加而变肥。
