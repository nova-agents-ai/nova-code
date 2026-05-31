# M2 — Chat REPL 设计稿

> 状态：Draft → Approved（2026-05-04）
> 对应 roadmap：Phase 1 · M2 · 多轮 REPL（chat 子命令）

## 〇、背景

M1.5 已交付 ask 单 shot 流程 + 稳定的 QueryEngine / services/api / 错误类 / debug sink。
M2 要在这套底座上加一个"能连续对话"的交互模式，同时偿还 M0 技术债 #4（debug sink 按 session 切分）。

与 claude-code 对应的参考：`claude-code/src/replLauncher.tsx`（仅看交互骨架，不抄 UI）、`claude-code/src/commands/<slash>/`（斜杠命令形态）、`claude-code/src/history.ts`（会话序列化思路）。

## 一、目标与 DoD

- 新增 `nova-code chat` 子命令，进入多轮交互
- 连续 10 轮对话不丢上下文（tool_use / tool_result 完整回流给模型）
- Ctrl+C 二级中断：运行中取消请求；闲时 1.5s 内双按才退出
- 斜杠命令：`/clear` `/exit` `/save` `/load` `/help`
- 暂不引入 React/Ink；用 `node:readline/promises` + `picocolors`
- debug sink 按 session 切分（prefix + sessionId 双参数化），偿还 M0 技术债 #4

## 二、非目标（留给后续 milestone）

- 多行 prompt 输入（M2 单行，`\` 续行 / `/edit` 开编辑器是 M13 TUI 前后）
- compact / microcompact（M4 专做）
- 权限审批集成（M3 接入 ChatSession）
- cost 统计面板（M5）
- resume 跨机器同步（M14）
- React/Ink 富 UI（M13 再上）

## 三、目录结构

```
src/
├── commands/
│   ├── ChatCommand/                          # 新增
│   │   ├── ChatCommand.ts                    # CommandDefinition 入口
│   │   ├── parseChatFlags.ts                 # --debug / --debug-pretty / --resume <id>
│   │   ├── runChatRepl.ts                    # REPL 主循环 + SIGINT 状态机
│   │   ├── ChatSession.ts                    # 持有 messages / 调 runAgentLoop
│   │   ├── renderAgentEvent.ts               # 纯函数事件 → I/O
│   │   ├── sessionId.ts                      # 生成 sessionId
│   │   ├── sessionStore.ts                   # ~/.nova-code/sessions/*.jsonl
│   │   └── slash/
│   │       ├── types.ts                      # SlashCommand / SlashResult / SlashContext
│   │       ├── registry.ts                   # builtinSlashCommands + findSlashCommand
│   │       ├── dispatcher.ts                 # 识别 /name 前缀并路由
│   │       ├── clear.ts
│   │       ├── exit.ts
│   │       ├── save.ts
│   │       ├── load.ts
│   │       └── help.ts
│   └── AskCommand/debugSink.ts               # 扩：prefix 参数（第六节）
├── QueryEngine.ts                            # 扩签名：initialMessages 参数
└── config/config.ts                          # 新增 getSessionsDirPath()
```

## 四、QueryEngine 扩签名

当前 [runAgentLoop](../../src/QueryEngine.ts) 固定把 `userPrompt` 作为 `messages[0]`。多轮对话要求"最新一条 user 消息前还有历史"。扩法保持向后兼容：

```ts
export interface AgentLoopParams {
  readonly config: ResolvedConfig;
  readonly userPrompt: string;
  readonly initialMessages?: readonly NovaMessage[]; // 新增
  // ...其余字段不变
}
```

实现侧把初始化 messages 改为：

```ts
const messages: NovaMessage[] = [
  ...(params.initialMessages ?? []),
  { role: MessageRoleEnum.USER, content: userPrompt },
];
```

ask 路径不传 initialMessages，行为不变；chat 每轮把已有 messages 作为 initialMessages 传入。

## 五、ChatSession 与事件渲染

```ts
export interface SessionMeta {
  readonly sessionId: string;
  readonly model: string;
  readonly createdAt: string; // ISO 8601
}

export class ChatSession {
  readonly meta: SessionMeta;
  private messages: NovaMessage[] = [];

  /** 跑一轮完整 loop：yield 事件 + 更新内部 messages。 */
  sendTurn(
    userInput: string,
    ctx: { config: ResolvedConfig; tools: readonly Tool[]; signal: AbortSignal },
  ): AsyncGenerator<AgentEvent, void, void>;

  clear(): void;                               // /clear
  snapshot(): readonly NovaMessage[];          // /save
  restore(meta: SessionMeta, msgs: readonly NovaMessage[]): void; // /load
}
```

- `sendTurn` 内部以当前 `messages` 作为 `initialMessages`、`userInput` 作为 `userPrompt` 调 `runAgentLoop`
- loop 结束时把 user 输入 + 最后一次 assistant message + 所有 tool_result 追加到 `this.messages`
  - 具体做法：从 generator 的 return 值（finalMessage）+ yield 出的 tool_result 事件拼出完整追加序列
  - 追加顺序严格遵循 user → assistant → tool_result_user → assistant → ... 的链条
- 事件流渲染抽为纯函数 `renderAgentEvent(event, io, state)`，ask 路径可复用，避免重复 switch

## 六、debug sink 按 session 切分

[buildDebugLogFileName](../../src/commands/AskCommand/debugSink.ts) 的 `ask-` 前缀硬编码要参数化。扩法：

```ts
export interface CreateFileDebugSinkOptions {
  readonly pretty: boolean;
  readonly sessionId?: string;
  readonly prefix?: string;   // 新增，默认 "ask"
}

export function buildDebugLogFileName(
  now: Date,
  pid: number,
  sessionId?: string,
  prefix = "ask",
): string
```

- ask 路径：不传 prefix（沿用 "ask"）、不传 sessionId（沿用 pid 后缀）→ 文件名格式完全不变，现有单测全部保持绿
- chat 路径：`prefix: "chat"` + `sessionId: <sid>` → `chat-2026-05-04T...-<sid>.log`

## 七、会话持久化（JSONL）

### 7.1 路径

`~/.nova-code/sessions/<sessionId>.jsonl`。新增 `getSessionsDirPath(source?)` 到 `src/config/config.ts`，套用 `getLogsDirPath` 的实现套路（只返回路径，不 mkdir）。

### 7.2 格式

首行 meta，后续每行一条 NovaMessage；用 `kind` 字段做 discriminator，未来兼容性更好：

```jsonl
{"kind":"meta","sessionId":"2026-05-04T...-ab12","model":"claude-...","createdAt":"..."}
{"kind":"msg","role":"user","content":"..."}
{"kind":"msg","role":"assistant","content":[{"type":"text",...},{"type":"tool_use",...}]}
{"kind":"msg","role":"user","content":[{"type":"tool_result",...}]}
```

读取：逐行 parse；容忍空行；首行非 meta 抛错。
写入：/save 每次覆盖写整份快照（M2 不做增量 append）。

### 7.3 sessionId 生成

`<ISO-YYYY-MM-DDTHH-mm-ss>-<randomHex8>`。字典序 = 时序，`ls -1 | tail` 即可找最近会话。随机 8 字节 hex 用 `crypto.randomBytes(4).toString("hex")`。

### 7.4 /save 与 /load

- `/save`：不带参数→按 `sessionId.jsonl` 覆盖写
- `/save <alias>`：额外再写一份 `<alias>.jsonl`，内容就是同一份 snapshot（M2 用文件副本而非 symlink，跨平台稳）
- `/load <id|alias>`：读入 meta + messages 后 `session.restore(...)`。如果当前会话非空（`snapshot().length > 0`），先打印 "当前会话将被替换，继续？(y/n)" 需要用户输入确认

## 八、Ctrl+C 二级中断

状态机：`idle | streaming`。

| 当前状态 | SIGINT 行为 |
|---|---|
| streaming | `abortController.abort()` → 当前流抛 AbortError → REPL 捕获后打印 `[cancelled]` 回到 `idle` |
| idle, 未处于"待退出窗口" | 打印 `(Press Ctrl+C again within 1.5s to exit)`；开启 1.5s timer；进入"待退出窗口" |
| idle, 处于"待退出窗口" | `process.exit(130)` |
| idle, "待退出窗口"超时 | 清状态，回到普通 idle |

实现点：
- `process.on("SIGINT", handler)` 注册全局处理；REPL 结束时 `removeListener`
- `readline` 默认的 SIGINT → SIGTSTP 行为要关掉：监听 `rl.on("SIGINT", ...)` 空实现即可阻止它默认 emit
- 取消时不退出 readline、不关 stdin，让用户继续输入下一轮

## 九、Chat 子命令入口

```
nova-code chat [--debug] [--debug-pretty] [--resume <id|alias>]
```

`parseChatFlags(args)` 返回 `{ debug, pretty, resumeId? }`。

`chatCommand.run` 流程：
1. `loadConfig()`（复用 ask 的错误映射，ConfigError → exit 1）
2. 新建或从 `--resume` 加载 ChatSession
3. 创建 debug sink（prefix="chat"、sessionId = session.meta.sessionId）
4. 进入 `runChatRepl(session, config, debugSink, io)`
5. finally 中 close sink、移除 SIGINT 监听

## 十、测试计划

### 10.1 单测（bun test）

- `QueryEngine.test.ts`：新增"initialMessages 被完整前置到请求 messages"用例，保留既有断言
- `ChatCommand/ChatSession.test.ts`：mock 版 runAgentLoop 注入固定事件序列，断言 3 轮对话后 snapshot 的 messages 顺序 / tool_use ↔ tool_result 配对正确 / clear 后 snapshot 为空 / restore 能把历史 messages 注入后继续 sendTurn
- `ChatCommand/sessionStore.test.ts`：save → load 往返 messages 深等；损坏 JSONL 抛错；别名文件覆盖写
- `ChatCommand/slash/dispatcher.test.ts`：非 `/` 前缀不触发；未知 `/xxx` 输出提示；`/exit` 返回 `{action:"exit"}`；`/clear` 清空 session
- `AskCommand/buildDebugLogFileName.test.ts`：补 prefix 参数的新用例，现有断言保持

### 10.2 e2e（bun test，沿用 M1.5 模式）

`src/m2-e2e-chat.test.ts`：
1. spawn 子进程跑 `chat` 连到内嵌 mock server
2. stdin 喂 3 轮对话 + `/save alias-a` + `/exit`
3. 再 spawn 一次 `chat --resume alias-a`，喂 1 轮
4. 断言：第 4 轮请求 body 里包含前 3 轮全部 user/assistant messages（context 未丢）
5. 断言：`<TMP_HOME>/.nova-code/sessions/` 下存在 `<sid>.jsonl` 与 `alias-a.jsonl`

## 十一、与 claude-code 的差异声明（§7.0 合规）

- `src/commands/ChatCommand/` 目录对齐 claude-code `src/commands/<Cmd>/` 模式
- 命名 ChatSession 而非 roadmap 暂称的 "Conversation"：对齐 claude-code 的 session 术语（session / sessionId / sessionStore 在 claude-code 是主线命名）
- 斜杠命令独立于顶层 CommandDefinition：claude-code 里 slash 命令和 CLI 命令本就是两套形态，nova 显式类型分离而非混用
- `renderAgentEvent` 纯函数抽取：claude-code 的渲染是 Ink 组件耦合 I/O，nova 在 M2 阶段保留 "io 接口注入" 的测试友好形态，待 M13 引入 Ink 后自然替换

## 十二、风险

- **readline 与 SIGINT 交互 corner case**：Node 版本差异可能让 `rl.on("SIGINT")` 行为不稳。缓解：顶层 `process.on("SIGINT")` 为主，readline 层只吞默认 exit
- **tool_result is_error=true 的 jsonl 往返**：NovaMessage 已覆盖 is_error 字段，单测保障
- **长会话 stdout 刷新**：`process.stdout.write` 不总 flush；每一轮 renderAgentEvent 结束补一个 `\n` 兜底
- **/save 的并发写**：M2 REPL 本就单线程，不考虑；M14 resume 若并发再补 file lock

## 十三、分 Task 执行顺序（串行，每步独立提交）

1. 写本设计稿
2. QueryEngine 扩 `initialMessages` + 单测
3. debugSink 扩 `prefix` + 单测
4. config.ts 加 `getSessionsDirPath`
5. ChatSession + 单测
6. sessionStore + 单测
7. SlashCommand 注册表 + 5 个内置命令 + dispatcher 单测
8. runChatRepl（readline + SIGINT 状态机）
9. ChatCommand 入口 + parseChatFlags，挂进 builtinCommands
10. m2-e2e-chat 子进程测试
11. 全量 `bun test` + `bun tsc --noEmit` + `biome check` 收官
